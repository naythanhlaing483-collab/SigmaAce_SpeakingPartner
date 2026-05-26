const { pbkdf2Sync, randomBytes } = require("crypto");
const { existsSync, readFileSync } = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DEFAULT_ADMIN_EMAIL = "admin@sigmaace.local";
const DEFAULT_ADMIN_PASSWORD = "Admin@12345";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);

    if (!match || process.env[match[1]]) {
      continue;
    }

    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");

  return `${salt}:${hash}`;
}

function getDefaultUserName(email) {
  return email.split("@")[0]?.trim() || "User";
}

async function ensureSchema(pool) {
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
      transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
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
    ALTER TABLE session_results ADD COLUMN IF NOT EXISTS weak_words JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE session_results ADD COLUMN IF NOT EXISTS gap_feedback TEXT;
  `);
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing. Add it to .env.local first.");
  }

  const localStorePath = path.join(process.cwd(), ".local-data", "flashy-learn.json");

  if (!existsSync(localStorePath)) {
    console.log("No .local-data/flashy-learn.json file exists. Nothing to migrate.");
    return;
  }

  const data = JSON.parse(readFileSync(localStorePath, "utf8"));
  const sslMode = (process.env.PGSSLMODE ?? "disable").trim().toLowerCase();
  const pool = new Pool({
    connectionString,
    ssl: sslMode === "require" ? { rejectUnauthorized: false } : false,
  });
  const generatedPasswords = [];

  try {
    await ensureSchema(pool);
    await pool.query("BEGIN");

    const users = data.users ?? [];
    const passwordHashes = data.passwordHashes ?? {};

    if (!users.some((user) => user.email === DEFAULT_ADMIN_EMAIL)) {
      users.push({
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
      passwordHashes["admin-default"] = hashPassword(DEFAULT_ADMIN_PASSWORD);
    }

    for (const user of users) {
      let passwordHash = passwordHashes[user.id];

      if (!passwordHash) {
        const temporaryPassword = `Temp-${randomBytes(4).toString("hex")}`;
        passwordHash = hashPassword(temporaryPassword);
        generatedPasswords.push(`${user.email}: ${temporaryPassword}`);
      }

      await pool.query(
        `
          INSERT INTO users (
            id, email, password_hash, name, name_changed, level, role, status,
            profile_image, profile_image_changed, daily_performance_note, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            password_hash = EXCLUDED.password_hash,
            name = EXCLUDED.name,
            name_changed = EXCLUDED.name_changed,
            level = EXCLUDED.level,
            role = EXCLUDED.role,
            status = EXCLUDED.status,
            profile_image = EXCLUDED.profile_image,
            profile_image_changed = EXCLUDED.profile_image_changed,
            daily_performance_note = EXCLUDED.daily_performance_note,
            created_at = EXCLUDED.created_at
        `,
        [
          user.id,
          user.email,
          passwordHash,
          user.name || getDefaultUserName(user.email),
          Boolean(user.nameChanged),
          user.level,
          user.role,
          user.status,
          user.profileImage ?? null,
          Boolean(user.profileImageChanged),
          user.dailyPerformanceNote ?? null,
          user.createdAt ?? Date.now(),
        ],
      );
    }

    for (const result of data.results ?? []) {
      const transcript = result.transcript ?? [];

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
          JSON.stringify(result.recommendations ?? []),
          JSON.stringify(transcript),
          JSON.stringify(result.weakWords ?? []),
          result.gapFeedback ?? null,
          result.notes ?? null,
          result.createdAt,
        ],
      );

      await pool.query("DELETE FROM conversation_messages WHERE session_result_id = $1", [
        result.id,
      ]);

      for (const [index, entry] of transcript.entries()) {
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
    }

    for (const request of data.resetRequests ?? []) {
      await pool.query(
        `
          INSERT INTO password_reset_requests (id, email, status, new_password, created_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            status = EXCLUDED.status,
            new_password = EXCLUDED.new_password,
            created_at = EXCLUDED.created_at
        `,
        [
          request.id,
          request.email,
          request.status,
          request.newPassword ?? null,
          request.createdAt,
        ],
      );
    }

    await pool.query("COMMIT");

    console.log(
      `Migrated ${users.length} users, ${(data.results ?? []).length} results, and ${(data.resetRequests ?? []).length} reset requests.`,
    );

    if (generatedPasswords.length) {
      console.log("Temporary passwords generated for users missing local hashes:");
      for (const line of generatedPasswords) {
        console.log(`- ${line}`);
      }
    }
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
