import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { Pool } from "pg";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  getDefaultUserName,
} from "@/lib/shared";
import type {
  AccountRole,
  AccountStatus,
  PasswordResetRequest,
  SessionResult,
  StoredData,
  TranscriptEntry,
  UserAccount,
  ConversationMessage,
} from "@/lib/shared";

type UserRow = {
  created_at: string;
  daily_performance_note: string | null;
  email: string;
  id: string;
  level: string;
  name: string | null;
  name_changed: boolean;
  profile_image: string | null;
  profile_image_changed: boolean;
  role: AccountRole;
  status: AccountStatus;
};

type ResultRow = {
  average_words_per_turn: string;
  balance_ratio: string;
  created_at: string;
  duration_seconds: number;
  gap_feedback: string | null;
  id: string;
  label: string;
  learner_turns: number;
  notes: string | null;
  overall_score: number;
  recommendations: string[] | string;
  student_email: string;
  student_id: string;
  total_turns: number;
  transcript: TranscriptEntry[] | string;
  weak_words: string[] | string;
};

type ConversationRow = {
  created_at: string;
  entry_id: string;
  message: string;
  message_index: number;
  role: TranscriptEntry["role"];
  session_result_id: string;
  source: TranscriptEntry["source"];
  student_email: string;
  student_id: string;
};

type ResetRow = {
  created_at: string;
  email: string;
  id: string;
  new_password: string | null;
  status: "pending" | "resolved";
};

type LocalStoredData = StoredData & {
  passwordHashes?: Record<string, string>;
};

declare global {
  var flashyLearnPool: Pool | undefined;
  var flashyLearnSchemaReady: Promise<void> | undefined;
  var flashyLearnUseLocalStore: boolean | undefined;
  var flashyLearnLocalWrite: Promise<void> | undefined;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required. Create .env.local with your Postgres connection string, then restart the dev server.",
    );
  }

  if (!global.flashyLearnPool) {
    const sslMode = (process.env.PGSSLMODE ?? "disable").trim().toLowerCase();

    global.flashyLearnPool = new Pool({
      connectionString,
      ssl: sslMode === "require" ? { rejectUnauthorized: false } : false,
    });
  }

  return global.flashyLearnPool;
}

function canUseLocalStore() {
  return (
    process.env.LOCAL_STORE_FALLBACK === "true" ||
    (process.env.LOCAL_STORE_FALLBACK !== "false" &&
      process.env.NODE_ENV !== "production")
  );
}

function getLocalStorePath() {
  return path.join(process.cwd(), ".local-data", "flashy-learn.json");
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [salt, hash] = storedHash.split(":");

  if (!salt || !hash) {
    return false;
  }

  const testHash = pbkdf2Sync(password, salt, 120000, 64, "sha512");
  const storedBuffer = Buffer.from(hash, "hex");

  return (
    storedBuffer.length === testHash.length &&
    timingSafeEqual(storedBuffer, testHash)
  );
}

async function ensureSchema() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      name_changed BOOLEAN NOT NULL DEFAULT FALSE,
      level TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
      status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'rejected')),
      profile_image TEXT,
      profile_image_changed BOOLEAN NOT NULL DEFAULT FALSE,
      daily_performance_note TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_results (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_email TEXT NOT NULL,
      label TEXT NOT NULL,
      overall_score INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      learner_turns INTEGER NOT NULL,
      total_turns INTEGER NOT NULL,
      average_words_per_turn NUMERIC NOT NULL,
      balance_ratio NUMERIC NOT NULL,
      recommendations JSONB NOT NULL,
      transcript JSONB NOT NULL,
      weak_words JSONB NOT NULL DEFAULT '[]'::jsonb,
      gap_feedback TEXT,
      notes TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      session_result_id TEXT NOT NULL REFERENCES session_results(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_email TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      source TEXT NOT NULL CHECK (source IN ('user', 'ai')),
      message TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (session_result_id, entry_id)
    );

    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'resolved')),
      new_password TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS session_results_student_created_idx
      ON session_results (student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS conversation_messages_result_order_idx
      ON conversation_messages (session_result_id, message_index, created_at);
    CREATE INDEX IF NOT EXISTS password_reset_requests_email_created_idx
      ON password_reset_requests (email, created_at DESC);
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name_changed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_changed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_performance_note TEXT;
    ALTER TABLE session_results ADD COLUMN IF NOT EXISTS transcript JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE session_results ADD COLUMN IF NOT EXISTS weak_words JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE session_results ADD COLUMN IF NOT EXISTS gap_feedback TEXT;
    UPDATE users
    SET name = split_part(email, '@', 1)
    WHERE name IS NULL OR btrim(name) = '';
  `);

  await pool.query(`
    INSERT INTO conversation_messages (
      id, session_result_id, student_id, student_email, entry_id, role, source,
      message, message_index, created_at
    )
    SELECT
      session_results.id || ':' || COALESCE(entry.value->>'entryId', entry.ordinality::text),
      session_results.id,
      session_results.student_id,
      session_results.student_email,
      COALESCE(entry.value->>'entryId', entry.ordinality::text),
      CASE
        WHEN entry.value->>'role' IN ('user', 'agent') THEN entry.value->>'role'
        ELSE 'agent'
      END,
      CASE
        WHEN entry.value->>'source' IN ('user', 'ai') THEN entry.value->>'source'
        ELSE 'ai'
      END,
      COALESCE(entry.value->>'message', ''),
      (entry.ordinality - 1)::integer,
      COALESCE((entry.value->>'timestamp')::bigint, session_results.created_at)
    FROM session_results
    CROSS JOIN LATERAL jsonb_array_elements(session_results.transcript)
      WITH ORDINALITY AS entry(value, ordinality)
    WHERE NOT EXISTS (
      SELECT 1
      FROM conversation_messages
      WHERE conversation_messages.session_result_id = session_results.id
    )
    ON CONFLICT (session_result_id, entry_id) DO NOTHING;
  `);

  const admin = await pool.query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = $1 LIMIT 1",
    [DEFAULT_ADMIN_EMAIL],
  );

  if (!admin.rowCount) {
    await pool.query(
      `
        INSERT INTO users (
          id, email, password_hash, name, name_changed, level, role, status,
          profile_image_changed, created_at
        )
        VALUES ($1, $2, $3, $4, FALSE, 'Admin', 'admin', 'active', FALSE, $5)
      `,
      [
        "admin-default",
        DEFAULT_ADMIN_EMAIL,
        hashPassword(DEFAULT_ADMIN_PASSWORD),
        getDefaultUserName(DEFAULT_ADMIN_EMAIL),
        Date.now(),
      ],
    );
  } else if (!verifyPassword(DEFAULT_ADMIN_PASSWORD, admin.rows[0].password_hash)) {
    await pool.query("UPDATE users SET password_hash = $1, status = 'active' WHERE id = $2", [
      hashPassword(DEFAULT_ADMIN_PASSWORD),
      admin.rows[0].id,
    ]);
  }
}

async function ready() {
  if (global.flashyLearnUseLocalStore) {
    return null;
  }

  if (!global.flashyLearnSchemaReady) {
    global.flashyLearnSchemaReady = ensureSchema();
  }

  try {
    await global.flashyLearnSchemaReady;
    return getPool();
  } catch (error) {
    global.flashyLearnSchemaReady = undefined;

    if (!canUseLocalStore()) {
      throw error;
    }

    global.flashyLearnUseLocalStore = true;
    console.warn(
      "Postgres is unavailable. Using the local development data store instead.",
      error,
    );

    return null;
  }
}

function cloneData(data: LocalStoredData): StoredData {
  return JSON.parse(
    JSON.stringify({
      conversationMessages: data.conversationMessages ?? [],
      resetRequests: data.resetRequests,
      results: data.results,
      users: data.users,
    }),
  ) as StoredData;
}

function ensureLocalAdmin(data: LocalStoredData) {
  data.passwordHashes ??= {};

  const admin = data.users.find((user) => user.email === DEFAULT_ADMIN_EMAIL);

  if (!admin) {
    data.users.push({
      createdAt: Date.now(),
      email: DEFAULT_ADMIN_EMAIL,
      id: "admin-default",
      level: "Admin",
      name: getDefaultUserName(DEFAULT_ADMIN_EMAIL),
      nameChanged: false,
      profileImageChanged: false,
      role: "admin",
      status: "active",
    });
  } else {
    admin.name ||= getDefaultUserName(admin.email);
    admin.nameChanged ??= false;
  }

  for (const user of data.users) {
    user.name ||= getDefaultUserName(user.email);
    user.nameChanged ??= false;
  }

  data.passwordHashes["admin-default"] = hashPassword(DEFAULT_ADMIN_PASSWORD);
}

async function readLocalData() {
  const storePath = getLocalStorePath();

  try {
    const content = await readFile(storePath, "utf8");
    const data = JSON.parse(content) as LocalStoredData;

    ensureLocalAdmin(data);
    return data;
  } catch {
    const data: LocalStoredData = {
      conversationMessages: [],
      passwordHashes: {},
      resetRequests: [],
      results: [],
      users: [],
    };

    ensureLocalAdmin(data);
    await writeLocalData(data);
    return data;
  }
}

async function writeLocalData(data: LocalStoredData) {
  const storePath = getLocalStorePath();
  const write = async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };

  global.flashyLearnLocalWrite = (global.flashyLearnLocalWrite ?? Promise.resolve()).then(write);
  await global.flashyLearnLocalWrite;
}

async function updateLocalData<T>(updater: (data: LocalStoredData) => T) {
  const data = await readLocalData();
  const result = updater(data);

  ensureLocalAdmin(data);
  await writeLocalData(data);

  return result;
}

function findLocalUser(data: StoredData, userId: string) {
  return data.users.find((user) => user.id === userId);
}

function mapUser(row: UserRow): UserAccount {
  return {
    createdAt: Number(row.created_at),
    dailyPerformanceNote: row.daily_performance_note ?? undefined,
    email: row.email,
    id: row.id,
    level: row.level,
    name: row.name?.trim() || getDefaultUserName(row.email),
    nameChanged: row.name_changed,
    profileImage: row.profile_image ?? undefined,
    profileImageChanged: row.profile_image_changed,
    role: row.role,
    status: row.status,
  };
}

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function mapResult(row: ResultRow): SessionResult {
  return {
    averageWordsPerTurn: Number(row.average_words_per_turn),
    balanceRatio: Number(row.balance_ratio),
    createdAt: Number(row.created_at),
    durationSeconds: row.duration_seconds,
    gapFeedback: row.gap_feedback ?? undefined,
    id: row.id,
    label: row.label,
    learnerTurns: row.learner_turns,
    notes: row.notes ?? undefined,
    overallScore: row.overall_score,
    recommendations: jsonValue<string[]>(row.recommendations),
    studentEmail: row.student_email,
    studentId: row.student_id,
    totalTurns: row.total_turns,
    transcript: jsonValue<TranscriptEntry[]>(row.transcript),
    weakWords: jsonValue<string[]>(row.weak_words),
  };
}

function mapConversation(row: ConversationRow): ConversationMessage {
  return {
    entryId: row.entry_id,
    message: row.message,
    role: row.role,
    sessionResultId: row.session_result_id,
    source: row.source,
    studentEmail: row.student_email,
    studentId: row.student_id,
    timestamp: Number(row.created_at),
  };
}

function mapReset(row: ResetRow): PasswordResetRequest {
  return {
    createdAt: Number(row.created_at),
    email: row.email,
    id: row.id,
    newPassword: row.new_password ?? undefined,
    status: row.status,
  };
}

export async function getData(): Promise<StoredData> {
  const pool = await ready();

  if (!pool) {
    return cloneData(await readLocalData());
  }

  const [users, results, resetRequests, conversationMessages] = await Promise.all([
    pool.query<UserRow>("SELECT * FROM users ORDER BY created_at DESC"),
    pool.query<ResultRow>("SELECT * FROM session_results ORDER BY created_at DESC"),
    pool.query<ResetRow>("SELECT * FROM password_reset_requests ORDER BY created_at DESC"),
    pool.query<ConversationRow>(
      "SELECT * FROM conversation_messages ORDER BY session_result_id, message_index, created_at",
    ),
  ]);
  const messagesByResult = new Map<string, TranscriptEntry[]>();

  for (const row of conversationMessages.rows) {
    const messages = messagesByResult.get(row.session_result_id) ?? [];

    messages.push(mapConversation(row));
    messagesByResult.set(row.session_result_id, messages);
  }

  return {
    conversationMessages: conversationMessages.rows.map(mapConversation),
    resetRequests: resetRequests.rows.map(mapReset),
    results: results.rows.map((row) => {
      const result = mapResult(row);
      const transcript = messagesByResult.get(result.id);

      return transcript?.length ? { ...result, transcript } : result;
    }),
    users: users.rows.map(mapUser),
  };
}

export async function login(email: string, password: string) {
  const pool = await ready();
  const normalizedEmail = email.trim().toLowerCase();

  if (!pool) {
    const data = await readLocalData();
    const user = data.users.find((item) => item.email === normalizedEmail);
    const storedHash = user ? data.passwordHashes?.[user.id] : undefined;

    if (!user || !storedHash || !verifyPassword(password, storedHash)) {
      throw new Error("Email or password is incorrect.");
    }

    if (user.status !== "active") {
      throw new Error("This account is waiting for admin approval.");
    }

    return user;
  }

  const result = await pool.query<UserRow & { password_hash: string }>(
    "SELECT * FROM users WHERE email = $1 LIMIT 1",
    [normalizedEmail],
  );
  const user = result.rows[0];

  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new Error("Email or password is incorrect.");
  }

  if (user.status !== "active") {
    throw new Error("This account is waiting for admin approval.");
  }

  return mapUser(user);
}

export async function createStudent(email: string, password: string, level: string) {
  const pool = await ready();
  const normalizedEmail = email.trim().toLowerCase();

  if (!pool) {
    await updateLocalData((data) => {
      if (data.users.some((user) => user.email === normalizedEmail)) {
        throw new Error("An account with this email already exists.");
      }

      const userId = createId("user");

      data.users.unshift({
        createdAt: Date.now(),
        email: normalizedEmail,
        id: userId,
        level,
        name: getDefaultUserName(normalizedEmail),
        nameChanged: false,
        profileImageChanged: false,
        role: "student",
        status: "active",
      });
      data.passwordHashes ??= {};
      data.passwordHashes[userId] = hashPassword(password);
    });
    return;
  }

  await pool.query(
    `
      INSERT INTO users (
        id, email, password_hash, name, name_changed, level, role, status,
        profile_image_changed, created_at
      )
      VALUES ($1, $2, $3, $4, FALSE, $5, 'student', 'active', FALSE, $6)
    `,
    [
      createId("user"),
      normalizedEmail,
      hashPassword(password),
      getDefaultUserName(normalizedEmail),
      level,
      Date.now(),
    ],
  );
}

export async function updateUserStatus(userId: string, status: AccountStatus) {
  const pool = await ready();

  if (!pool) {
    await updateLocalData((data) => {
      const user = findLocalUser(data, userId);

      if (user?.role === "student") {
        user.status = status;
      }
    });
    return;
  }

  await pool.query("UPDATE users SET status = $1 WHERE id = $2 AND role = 'student'", [
    status,
    userId,
  ]);
}

export async function changePassword(userId: string, password: string) {
  const pool = await ready();

  if (!pool) {
    await updateLocalData((data) => {
      if (password.length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }

      if (!findLocalUser(data, userId)) {
        return;
      }

      data.passwordHashes ??= {};
      data.passwordHashes[userId] = hashPassword(password);
    });
    return;
  }

  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    hashPassword(password),
    userId,
  ]);
}

export async function updateUserName(userId: string, name: string) {
  const pool = await ready();
  const normalizedName = name.trim();

  if (normalizedName.length < 2) {
    throw new Error("Name must be at least 2 characters.");
  }

  if (!pool) {
    await updateLocalData((data) => {
      const user = findLocalUser(data, userId);

      if (!user || user.role !== "student") {
        return;
      }

      if (user.nameChanged) {
        throw new Error("Name can only be changed once.");
      }

      user.name = normalizedName;
      user.nameChanged = true;
    });
    return;
  }

  const existing = await pool.query<{ name_changed: boolean; role: AccountRole }>(
    "SELECT name_changed, role FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  const user = existing.rows[0];

  if (!user || user.role !== "student") {
    return;
  }

  if (user.name_changed) {
    throw new Error("Name can only be changed once.");
  }

  await pool.query(
    "UPDATE users SET name = $1, name_changed = TRUE WHERE id = $2 AND role = 'student'",
    [normalizedName, userId],
  );
}

export async function updateStudent(
  userId: string,
  updates: {
    email: string;
    level: string;
    name: string;
    status: AccountStatus;
  },
) {
  const pool = await ready();
  const normalizedEmail = updates.email.trim().toLowerCase();
  const normalizedName = updates.name.trim() || getDefaultUserName(normalizedEmail);

  if (!normalizedEmail) {
    throw new Error("Email is required.");
  }

  if (normalizedName.length < 2) {
    throw new Error("Name must be at least 2 characters.");
  }

  if (!pool) {
    await updateLocalData((data) => {
      const user = findLocalUser(data, userId);

      if (!user || user.role !== "student") {
        return;
      }

      if (
        data.users.some(
          (item) => item.id !== userId && item.email === normalizedEmail,
        )
      ) {
        throw new Error("An account with this email already exists.");
      }

      const previousEmail = user.email;
      user.email = normalizedEmail;
      user.level = updates.level;
      user.name = normalizedName;
      user.status = updates.status;

      for (const result of data.results) {
        if (result.studentId === userId) {
          result.studentEmail = normalizedEmail;
        }
      }

      for (const message of data.conversationMessages ?? []) {
        if (message.studentId === userId) {
          message.studentEmail = normalizedEmail;
        }
      }

      for (const request of data.resetRequests) {
        if (request.email === previousEmail) {
          request.email = normalizedEmail;
        }
      }
    });
    return;
  }

  await pool.query("BEGIN");
  try {
    const existing = await pool.query<{ email: string }>(
      "SELECT email FROM users WHERE id = $1 AND role = 'student' LIMIT 1",
      [userId],
    );
    const previousEmail = existing.rows[0]?.email;

    await pool.query(
      `
        UPDATE users
        SET email = $1, level = $2, name = $3, status = $4
        WHERE id = $5 AND role = 'student'
      `,
      [normalizedEmail, updates.level, normalizedName, updates.status, userId],
    );
    await pool.query(
      "UPDATE session_results SET student_email = $1 WHERE student_id = $2",
      [normalizedEmail, userId],
    );
    await pool.query(
      "UPDATE conversation_messages SET student_email = $1 WHERE student_id = $2",
      [normalizedEmail, userId],
    );
    await pool.query(
      `
        UPDATE password_reset_requests
        SET email = $1
        WHERE email = $2
      `,
      [normalizedEmail, previousEmail ?? normalizedEmail],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function deleteStudent(userId: string) {
  const pool = await ready();

  if (!pool) {
    await updateLocalData((data) => {
      const user = findLocalUser(data, userId);

      if (!user || user.role !== "student") {
        return;
      }

      data.users = data.users.filter((item) => item.id !== userId);
      data.results = data.results.filter((result) => result.studentId !== userId);
      data.conversationMessages = data.conversationMessages?.filter(
        (message) => message.studentId !== userId,
      );
      data.resetRequests = data.resetRequests.filter(
        (request) => request.email !== user.email,
      );
      if (data.passwordHashes) {
        delete data.passwordHashes[userId];
      }
    });
    return;
  }

  const existing = await pool.query<{ email: string; role: AccountRole }>(
    "SELECT email, role FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  const user = existing.rows[0];

  if (!user || user.role !== "student") {
    return;
  }

  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM password_reset_requests WHERE email = $1", [
      user.email,
    ]);
    await pool.query("DELETE FROM users WHERE id = $1 AND role = 'student'", [
      userId,
    ]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function updateProfileImage(userId: string, profileImage: string) {
  const pool = await ready();

  if (!pool) {
    await updateLocalData((data) => {
      const user = findLocalUser(data, userId);

      if (!user) {
        return;
      }

      if (user.profileImageChanged) {
        throw new Error("Profile image upload has already been used.");
      }

      user.profileImage = profileImage;
      user.profileImageChanged = true;
    });
    return;
  }

  const existing = await pool.query<{ profile_image_changed: boolean }>(
    "SELECT profile_image_changed FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );

  if (existing.rows[0]?.profile_image_changed) {
    throw new Error("Profile image upload has already been used.");
  }

  await pool.query(
    "UPDATE users SET profile_image = $1, profile_image_changed = TRUE WHERE id = $2",
    [profileImage, userId],
  );
}

export async function saveDailyNote(userId: string, note: string) {
  const pool = await ready();

  if (!pool) {
    await updateLocalData((data) => {
      const user = findLocalUser(data, userId);

      if (user?.role === "student") {
        user.dailyPerformanceNote = note;
      }
    });
    return;
  }

  await pool.query(
    "UPDATE users SET daily_performance_note = $1 WHERE id = $2 AND role = 'student'",
    [note, userId],
  );
}

export async function saveResult(result: SessionResult) {
  const pool = await ready();

  if (!pool) {
    await updateLocalData((data) => {
      data.conversationMessages = [
        ...(data.conversationMessages ?? []).filter(
          (message) => message.sessionResultId !== result.id,
        ),
        ...result.transcript.map((entry) => ({
          ...entry,
          sessionResultId: result.id,
          studentEmail: result.studentEmail,
          studentId: result.studentId,
        })),
      ];
      data.results = data.results.filter((item) => item.id !== result.id);
      data.results.unshift(result);
    });
    return;
  }

  await pool.query("BEGIN");
  try {
    await pool.query(
      `
        INSERT INTO session_results (
          id, student_id, student_email, label, overall_score, duration_seconds,
          learner_turns, total_turns, average_words_per_turn, balance_ratio,
          recommendations, transcript, weak_words, gap_feedback, notes, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
          student_id = EXCLUDED.student_id,
          student_email = EXCLUDED.student_email,
          label = EXCLUDED.label,
          overall_score = EXCLUDED.overall_score,
          duration_seconds = EXCLUDED.duration_seconds,
          learner_turns = EXCLUDED.learner_turns,
          total_turns = EXCLUDED.total_turns,
          average_words_per_turn = EXCLUDED.average_words_per_turn,
          balance_ratio = EXCLUDED.balance_ratio,
          recommendations = EXCLUDED.recommendations,
          transcript = EXCLUDED.transcript,
          weak_words = EXCLUDED.weak_words,
          gap_feedback = EXCLUDED.gap_feedback,
          notes = EXCLUDED.notes,
          created_at = EXCLUDED.created_at
      `,
      [
        result.id,
        result.studentId,
        result.studentEmail,
        result.label,
        result.overallScore,
        result.durationSeconds,
        result.learnerTurns,
        result.totalTurns,
        result.averageWordsPerTurn,
        result.balanceRatio,
        JSON.stringify(result.recommendations),
        JSON.stringify(result.transcript),
        JSON.stringify(result.weakWords ?? []),
        result.gapFeedback ?? null,
        result.notes ?? null,
        result.createdAt,
      ],
    );

    await pool.query("DELETE FROM conversation_messages WHERE session_result_id = $1", [
      result.id,
    ]);

    for (const [index, entry] of result.transcript.entries()) {
      await pool.query(
        `
          INSERT INTO conversation_messages (
            id, session_result_id, student_id, student_email, entry_id, role,
            source, message, message_index, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          `${result.id}:${entry.entryId}`,
          result.id,
          result.studentId,
          result.studentEmail,
          entry.entryId,
          entry.role,
          entry.source,
          entry.message,
          index,
          entry.timestamp,
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
