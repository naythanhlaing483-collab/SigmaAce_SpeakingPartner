"use client";

import {
  ConversationProvider,
  useConversation,
} from "@elevenlabs/react";
import Image from "next/image";
import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  AccountStatus,
  getUserDisplayName,
  QualitySnapshot,
  SessionResult,
  StoredData,
  TranscriptEntry,
  UserAccount,
} from "@/lib/shared";

const DEFAULT_AGENT_ID = "agent_3901kge88pyjfgftr735d40j1x4v";
const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? DEFAULT_AGENT_ID;
const CURRENT_USER_KEY = "flashy-learn-current-user-v1";

type SpeakingLevel = "Beginner" | "Intermediate" | "Advanced" | "Testing";

const categories = [
  {
    name: "Beginner",
    description: "Daily basics, slow prompts, and confidence drills.",
  },
  {
    name: "Intermediate",
    description: "Conversational practice with structure and feedback.",
  },
  {
    name: "Advanced",
    description: "High-speed discussions, nuance, and fluency challenges.",
  },
  {
    name: "Testing",
    description: "Admin-level access for testing every speaking portal.",
  },
] as const satisfies readonly { name: SpeakingLevel; description: string }[];

type AuthPanel = "login" | "forgot";
type ViewState = "loading" | "home" | "portal" | "session" | "leaving";

const emptySnapshot: QualitySnapshot = {
  averageWordsPerTurn: 0,
  balanceRatio: 0,
  durationSeconds: 0,
  label: "Warm-Up",
  learnerTurns: 0,
  overallScore: 0,
  recommendations: ["Complete a speaking session to receive feedback."],
  totalTurns: 0,
};

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createDefaultData(): StoredData {
  return {
    resetRequests: [],
    results: [],
    users: [],
  };
}

function normalizeSpeakingLevel(level: string): SpeakingLevel {
  const match = categories.find(
    (category) => category.name.toLowerCase() === level.trim().toLowerCase(),
  );

  return match?.name ?? "Beginner";
}

function canAccessCategory(user: UserAccount, categoryName: SpeakingLevel) {
  const userLevel = normalizeSpeakingLevel(user.level);

  return userLevel === "Testing" || userLevel === categoryName;
}

function getPersistedUserId() {
  const localUserId = window.localStorage.getItem(CURRENT_USER_KEY);
  const sessionUserId = window.sessionStorage.getItem(CURRENT_USER_KEY);
  const userId = localUserId ?? sessionUserId;

  if (sessionUserId && !localUserId) {
    window.localStorage.setItem(CURRENT_USER_KEY, sessionUserId);
  }

  return userId;
}

function persistUserId(userId: string) {
  window.localStorage.setItem(CURRENT_USER_KEY, userId);
  window.sessionStorage.setItem(CURRENT_USER_KEY, userId);
}

function clearPersistedUserId() {
  window.localStorage.removeItem(CURRENT_USER_KEY);
  window.sessionStorage.removeItem(CURRENT_USER_KEY);
}

type ApiResponse = {
  data?: StoredData;
  error?: string;
  user?: UserAccount;
};

type FeedbackResponse = {
  error?: string;
  result?: SessionResult;
};

async function apiRequest(body?: Record<string, unknown>): Promise<ApiResponse> {
  const response = await fetch("/api/data", {
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    method: body ? "POST" : "GET",
  });
  const payload = (await response.json()) as ApiResponse;

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

async function getAiFeedbackResult(result: SessionResult) {
  const response = await fetch("/api/openrouter/feedback", {
    body: JSON.stringify({ result }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json()) as FeedbackResponse;

  if (!response.ok && !payload.result) {
    throw new Error(payload.error || "AI feedback request failed.");
  }

  return payload.result ?? result;
}

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function isToday(timestamp: number) {
  const now = new Date();
  const date = new Date(timestamp);

  return (
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate()
  );
}

function buildQualitySnapshot(
  transcript: TranscriptEntry[],
  startedAt: number | null,
  endedAt: number | null,
): QualitySnapshot {
  const learnerTurns = transcript.filter((entry) => entry.role === "user");
  const agentTurns = transcript.filter((entry) => entry.role === "agent");
  const durationSeconds = startedAt
    ? Math.max(Math.round(((endedAt ?? Date.now()) - startedAt) / 1000), 0)
    : 0;
  const learnerWordCount = learnerTurns.reduce(
    (total, entry) =>
      total + entry.message.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
  const averageWordsPerTurn = learnerTurns.length
    ? learnerWordCount / learnerTurns.length
    : 0;
  const balanceRatio =
    learnerTurns.length && agentTurns.length
      ? Math.min(learnerTurns.length, agentTurns.length) /
        Math.max(learnerTurns.length, agentTurns.length)
      : 0;

  const durationScore = Math.min(durationSeconds / 180, 1) * 40;
  const turnScore = Math.min(learnerTurns.length / 8, 1) * 30;
  const balanceScore = balanceRatio * 20;
  const depthScore = Math.min(averageWordsPerTurn / 12, 1) * 10;
  const overallScore = Math.round(
    durationScore + turnScore + balanceScore + depthScore,
  );

  let label = "Warm-Up";
  if (overallScore >= 80) {
    label = "Excellent Flow";
  } else if (overallScore >= 65) {
    label = "Strong Practice";
  } else if (overallScore >= 45) {
    label = "Developing";
  }

  const recommendations: string[] = [];

  if (durationSeconds < 90) {
    recommendations.push("Stay in the session longer to build rhythm.");
  }

  if (learnerTurns.length < 4) {
    recommendations.push("Give more replies so the agent can assess your level.");
  }

  if (averageWordsPerTurn < 6) {
    recommendations.push("Try slightly longer answers with examples or reasons.");
  }

  if (balanceRatio < 0.6) {
    recommendations.push("Aim for a steadier back-and-forth exchange.");
  }

  if (!recommendations.length) {
    recommendations.push("Keep this pace and add more specific vocabulary next round.");
  }

  return {
    averageWordsPerTurn,
    balanceRatio,
    durationSeconds,
    label,
    learnerTurns: learnerTurns.length,
    overallScore,
    recommendations,
    totalTurns: transcript.length,
  };
}

function getNameInitials(user: UserAccount) {
  return getUserDisplayName(user).slice(0, 2).toUpperCase();
}

function summarizeStudent(results: SessionResult[]) {
  const latest = results[0];
  const todayResults = results.filter((result) => isToday(result.createdAt));
  const averageScore = results.length
    ? Math.round(
        results.reduce((total, result) => total + result.overallScore, 0) /
          results.length,
      )
    : 0;
  const todayAverage = todayResults.length
    ? Math.round(
        todayResults.reduce((total, result) => total + result.overallScore, 0) /
          todayResults.length,
      )
    : 0;

  return {
    averageScore,
    latest,
    sessionCount: results.length,
    todayAverage,
    todayCount: todayResults.length,
  };
}

function AuthScreen({
  onLogin,
  onDataChange,
}: {
  onLogin: (user: UserAccount) => void;
  onDataChange: (data: StoredData) => void;
}) {
  const [panel, setPanel] = useState<AuthPanel>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();

    try {
      const response = await apiRequest({
        action: "login",
        email: normalizedEmail,
        password,
      });

      if (response.data) {
        onDataChange(response.data);
      }

      if (response.user) {
        setMessage("");
        onLogin(response.user);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed.");
    }
  };

  const handleForgot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();

    try {
      const response = await apiRequest({
        action: "forgot",
        email: normalizedEmail,
      });

      if (response.data) {
        onDataChange(response.data);
      }

      setPanel("login");
      setMessage("Password reset request sent to the admin dashboard.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reset request failed.");
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-logo-wrap">
          <Image src="/SA1.png" alt="SA1 logo" width={104} height={104} priority />
        </div>
        <div className="auth-tabs" aria-label="Authentication options">
          <button
            type="button"
            className={panel === "login" ? "auth-tab-active" : ""}
            onClick={() => setPanel("login")}
          >
            Login
          </button>
          <button
            type="button"
            className={panel === "forgot" ? "auth-tab-active" : ""}
            onClick={() => setPanel("forgot")}
          >
            Forgot
          </button>
        </div>

        <form
          className="form-stack"
          onSubmit={panel === "login" ? handleLogin : handleForgot}
        >
          <div>
            <p className="eyebrow">
              {panel === "login" ? "Account Login" : "Password Help"}
            </p>
            <h2>
              {panel === "login" ? "Enter your account" : "Ask admin to reset"}
            </h2>
          </div>

          <label>
            Email
            <input
              autoComplete="email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          {panel !== "forgot" ? (
            <label>
              Password
              <input
                autoComplete={panel === "login" ? "current-password" : "new-password"}
                minLength={6}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          ) : null}

          {message ? <p className="form-message">{message}</p> : null}

          <button type="submit" className="call-button">
            {panel === "login" ? "Login" : "Request Reset"}
          </button>
        </form>

        {/* <div className="admin-credential-box auth-admin-notes">
          <span>Default Admin Login</span>
          <strong>{DEFAULT_ADMIN_EMAIL}</strong>
          <strong>{DEFAULT_ADMIN_PASSWORD}</strong>
        </div> */}
      </section>
    </main>
  );
}

function DatabaseSetupScreen({ message }: { message: string }) {
  return (
    <main className="auth-shell">
      <section className="auth-card db-setup-card">
        <div className="auth-logo-wrap">
          <Image src="/SA1.png" alt="SA1 logo" width={104} height={104} priority />
        </div>
        <div className="form-stack">
          <div>
            <p className="eyebrow">Database Setup</p>
            <h2>Connect Postgres to continue</h2>
          </div>
          <p className="setup-copy">{message}</p>
          <div className="env-example">
            <span>.env.local</span>
            <code>DATABASE_URL=postgres://postgres:postgres@localhost:5432/flashy_learn</code>
            <code>PGSSLMODE=disable</code>
          </div>
          <p className="setup-copy">
            Restart the dev server after saving `.env.local`. The app will create
            its tables and default admin account automatically.
          </p>
        </div>
      </section>
    </main>
  );
}

function ProfileBadge({ user }: { user: UserAccount }) {
  return user.profileImage ? (
    <img className="profile-avatar" src={user.profileImage} alt="" />
  ) : (
    <span className="profile-avatar profile-avatar-fallback">
      {getNameInitials(user)}
    </span>
  );
}

function StudentAccountDropdown({
  currentUser,
  onLogout,
  onName,
  onNameChange,
  onProfileImage,
  profileName,
  profileMessage,
}: {
  currentUser: UserAccount;
  onLogout: () => void;
  onName: (event: FormEvent<HTMLFormElement>) => void;
  onNameChange: (name: string) => void;
  onProfileImage: (event: ChangeEvent<HTMLInputElement>) => void;
  profileName: string;
  profileMessage: string;
}) {
  return (
    <details className="account-menu">
      <summary aria-label="Open account settings">
        <ProfileBadge user={currentUser} />
        <span className="account-summary-copy">
          <strong>{getUserDisplayName(currentUser)}</strong>
          <span>{currentUser.level} level</span>
        </span>
        <span className="dropdown-caret" aria-hidden="true" />
      </summary>
      <div className="account-dropdown-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Account</p>
            <h3>Settings</h3>
          </div>
          <button type="button" className="leave-button" onClick={onLogout}>
            Logout
          </button>
        </div>
        <form className="form-stack compact-form" onSubmit={onName}>
          <label>
            Display Name
            <input
              disabled={currentUser.nameChanged}
              minLength={2}
              required
              type="text"
              value={profileName}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="ghost-button"
            disabled={currentUser.nameChanged}
          >
            Change Name
          </button>
        </form>
        <label className="upload-control">
          Upload Profile Image Once
          <input
            accept="image/*"
            disabled={currentUser.profileImageChanged}
            type="file"
            onChange={onProfileImage}
          />
        </label>
        <p className="form-message">
          {profileMessage ||
            (currentUser.nameChanged
              ? "Name change has already been used."
              : "You can change your display name one time.")}
        </p>
      </div>
    </details>
  );
}

function StudentHome({
  currentUser,
  onChangeName,
  onLogout,
  onOpenPortal,
  onProfileImage,
  results,
}: {
  currentUser: UserAccount;
  onChangeName: (name: string) => Promise<void>;
  onLogout: () => void;
  onOpenPortal: (categoryName: SpeakingLevel) => void;
  onProfileImage: (profileImage: string) => Promise<void>;
  results: SessionResult[];
}) {
  const [profileName, setProfileName] = useState(getUserDisplayName(currentUser));
  const [profileMessage, setProfileMessage] = useState("");
  const sortedResults = useMemo(
    () => [...results].sort((a, b) => b.createdAt - a.createdAt),
    [results],
  );
  const todayResults = useMemo(
    () => sortedResults.filter((result) => isToday(result.createdAt)),
    [sortedResults],
  );
  const summary = summarizeStudent(sortedResults);

  useEffect(() => {
    setProfileName(getUserDisplayName(currentUser));
  }, [currentUser]);

  const handleNameChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      await onChangeName(profileName);
      setProfileMessage("Name changed.");
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "Name change failed.");
    }
  };

  const handleProfileImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || currentUser.profileImageChanged) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await onProfileImage(reader.result?.toString() ?? "");
        setProfileMessage("Profile image uploaded. This one-time upload is now used.");
      } catch (error) {
        setProfileMessage(error instanceof Error ? error.message : "Profile upload failed.");
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="home-screen">
      <header className="app-topbar">
        <div className="nav-brand">
          <Image src="/SA1.png" alt="SA1 logo" width={52} height={52} />
          <div>
            <p className="eyebrow">Speaking Budy</p>
            <h2>Practice dashboard</h2>
          </div>
        </div>
        <StudentAccountDropdown
          currentUser={currentUser}
          onLogout={onLogout}
          onName={handleNameChange}
          onNameChange={setProfileName}
          onProfileImage={handleProfileImage}
          profileName={profileName}
          profileMessage={profileMessage}
        />
      </header>

      <div className="dashboard-grid">
        <section className="hero-panel student-hero">
          <p className="eyebrow">Pick Your Practice Path</p>
          <h1>English speaking practice built for teen learners.</h1>
          <p className="hero-text">
            Open the speaking portal that matches your account level. Testing
            level accounts can open every portal for review.
          </p>
        </section>
      </div>

      <div className="category-grid">
        {categories.map((category) => {
          const isUnlocked = canAccessCategory(currentUser, category.name);

          return isUnlocked ? (
            <button
              key={category.name}
              type="button"
              className="category-card category-card-active"
              onClick={() => onOpenPortal(category.name)}
            >
              <span className="category-status">Unlocked</span>
              <h2>{category.name}</h2>
              <p>{category.description}</p>
              <span className="category-action">Enter Portal</span>
            </button>
          ) : (
            <div
              key={category.name}
              className="category-card category-card-locked"
              aria-disabled="true"
            >
              <span className="category-status">Level Locked</span>
              <h2>{category.name}</h2>
              <p>{category.description}</p>
              <span className="category-action">Locked</span>
            </div>
          );
        })}
      </div>

      <section className="student-results-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Speaking Results</p>
            <h3>Daily performance</h3>
          </div>
        </div>
        <div className="quality-metrics">
          <div className="metric-card">
            <span>Today Sessions</span>
            <strong>{summary.todayCount}</strong>
          </div>
          <div className="metric-card">
            <span>Today Average</span>
            <strong>{summary.todayAverage}</strong>
          </div>
          <div className="metric-card">
            <span>All Sessions</span>
            <strong>{summary.sessionCount}</strong>
          </div>
          <div className="metric-card">
            <span>Overall Average</span>
            <strong>{summary.averageScore}</strong>
          </div>
        </div>
        {currentUser.dailyPerformanceNote ? (
          <div className="recommendation-block">
            <p className="feedback-label">Admin Daily Note</p>
            <p>{currentUser.dailyPerformanceNote}</p>
          </div>
        ) : null}
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Today</p>
            <h3>Result and notes</h3>
          </div>
        </div>
        <ResultList
          emptyText="No results recorded today."
          results={todayResults}
          showTranscriptPreview
        />
        <div className="panel-heading">
          <div>
            <p className="eyebrow">History</p>
            <h3>All speaking results</h3>
          </div>
        </div>
        <ResultList
          compactCards
          emptyText="No speaking results yet."
          results={sortedResults}
          showTranscriptPreview
        />
      </section>
    </section>
  );
}

function ResultList({
  compactCards = false,
  emptyText,
  listClassName = "",
  results,
  showTranscriptPreview = false,
}: {
  compactCards?: boolean;
  emptyText: string;
  listClassName?: string;
  results: SessionResult[];
  showTranscriptPreview?: boolean;
}) {
  const [previewResult, setPreviewResult] = useState<SessionResult | null>(null);
  const previewTranscript = useMemo(
    () =>
      previewResult
        ? [...(previewResult.transcript ?? [])].sort(
            (a, b) => a.timestamp - b.timestamp,
          )
        : [],
    [previewResult],
  );

  if (!results.length) {
    return (
      <div className="empty-panel">
        <p>{emptyText}</p>
      </div>
    );
  }

  const listClasses = [
    "result-list",
    compactCards ? "result-compact-list" : "",
    listClassName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={listClasses}>
      {results.map((result) => (
        <article
          key={result.id}
          className={`result-row ${compactCards ? "result-compact-card" : ""}`}
        >
          {compactCards ? (
            <div className="result-compact-body">
              <div className="result-compact-meta">
                <span>Marks</span>
                <strong>{result.overallScore}</strong>
              </div>
              <div className="result-compact-meta">
                <span>Time</span>
                <strong>{formatClock(result.durationSeconds)}</strong>
              </div>
              <div className="result-compact-meta result-compact-date">
                <span>Date</span>
                <strong>{formatDate(result.createdAt)}</strong>
              </div>
              <p>
                Conversation quality: {result.label || "Available after call"}
              </p>
            </div>
          ) : (
            <div>
              <strong>{result.label}</strong>
              <span>{formatDate(result.createdAt)}</span>
              {result.notes ? <p>{result.notes}</p> : null}
            </div>
          )}
          <div className="result-actions">
            {showTranscriptPreview ? (
              <button
                type="button"
                className="ghost-button compact-button"
                onClick={() => setPreviewResult(result)}
                disabled={!result.transcript?.length}
              >
                View Chat
              </button>
            ) : null}
            {!compactCards ? (
              <div className="result-score">
                <strong>{result.overallScore}</strong>
                <span>{formatClock(result.durationSeconds)}</span>
              </div>
            ) : null}
          </div>
        </article>
      ))}
      {previewResult ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-preview-title"
        >
          <section className="chat-preview-modal">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Conversation Script</p>
                <h3 id="chat-preview-title">{previewResult.label}</h3>
              </div>
              <button
                type="button"
                className="ghost-button compact-button"
                onClick={() => setPreviewResult(null)}
              >
                Close
              </button>
            </div>
            <div className="chat-preview-list">
              {previewTranscript.length ? (
                previewTranscript.map((entry) => (
                  <article
                    key={entry.entryId}
                    className={`chat-preview-bubble chat-preview-${entry.role}`}
                  >
                    <span>{entry.role === "user" ? "You" : "Agent"}</span>
                    <p>{entry.message}</p>
                  </article>
                ))
              ) : (
                <div className="empty-panel">
                  <p>No conversation script was saved for this result.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function AdminDashboard({
  data,
  onDataChange,
  onLogout,
}: {
  data: StoredData;
  onDataChange: (data: StoredData) => void;
  onLogout: () => void;
}) {
  const [accountEmail, setAccountEmail] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountLevel, setAccountLevel] = useState("Beginner");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [detailStudentId, setDetailStudentId] = useState("");
  const [editingStudentId, setEditingStudentId] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editLevel, setEditLevel] = useState<SpeakingLevel>("Beginner");
  const [editName, setEditName] = useState("");
  const [editStatus, setEditStatus] = useState<AccountStatus>("active");
  const [manualScore, setManualScore] = useState("70");
  const [manualNotes, setManualNotes] = useState("");
  const [dailyNote, setDailyNote] = useState("");
  const students = data.users.filter((user) => user.role === "student");
  const activeStudents = students.filter((user) => user.status === "active");
  const todayResults = data.results.filter((result) => isToday(result.createdAt));
  const averageTodayScore = todayResults.length
    ? Math.round(
        todayResults.reduce((total, result) => total + result.overallScore, 0) /
          todayResults.length,
      )
    : 0;
  const detailStudent = students.find((student) => student.id === detailStudentId);
  const detailResults = detailStudent
    ? data.results
        .filter((result) => result.studentId === detailStudent.id)
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
  const detailSummary = summarizeStudent(detailResults);

  const refreshFromResponse = (response: ApiResponse) => {
    if (response.data) {
      onDataChange(response.data);
    }
  };

  const startEditStudent = (student: UserAccount) => {
    setEditingStudentId(student.id);
    setEditEmail(student.email);
    setEditLevel(normalizeSpeakingLevel(student.level));
    setEditName(getUserDisplayName(student));
    setEditStatus(student.status);
  };

  const cancelEditStudent = () => {
    setEditingStudentId("");
    setEditEmail("");
    setEditLevel("Beginner");
    setEditName("");
    setEditStatus("active");
  };

  const saveStudentEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!editingStudentId) {
      return;
    }

    refreshFromResponse(
      await apiRequest({
        action: "update-student",
        email: editEmail,
        level: editLevel,
        name: editName,
        status: editStatus,
        userId: editingStudentId,
      }),
    );
    cancelEditStudent();
  };

  const deleteStudentAccount = async (student: UserAccount) => {
    if (!window.confirm(`Delete ${getUserDisplayName(student)} and all saved results?`)) {
      return;
    }

    refreshFromResponse(
      await apiRequest({
        action: "delete-student",
        userId: student.id,
      }),
    );

    if (detailStudentId === student.id) {
      setDetailStudentId("");
    }

    if (editingStudentId === student.id) {
      cancelEditStudent();
    }
  };

  const updateStatus = async (userId: string, status: "active" | "rejected") => {
    refreshFromResponse(
      await apiRequest({
        action: "update-user-status",
        status,
        userId,
      }),
    );
  };

  const createStudent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = accountEmail.trim().toLowerCase();

    refreshFromResponse(
      await apiRequest({
        action: "create-student",
        email: normalizedEmail,
        level: accountLevel,
        password: accountPassword,
      }),
    );
    setAccountEmail("");
    setAccountPassword("");
  };

  const addManualResult = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const student = activeStudents.find((user) => user.id === selectedStudentId);
    const score = Math.max(0, Math.min(Number(manualScore) || 0, 100));

    if (!student) {
      return;
    }

    refreshFromResponse(
      await apiRequest({
        action: "save-result",
        result: {
          ...emptySnapshot,
          createdAt: Date.now(),
          durationSeconds: 0,
          id: createId("manual-result"),
          label: score >= 80 ? "Excellent Flow" : score >= 60 ? "Strong Practice" : "Developing",
          notes: manualNotes,
          overallScore: score,
          recommendations: manualNotes ? [manualNotes] : ["Manual admin result."],
          studentEmail: student.email,
          studentId: student.id,
          transcript: [],
        },
      }),
    );
    setManualNotes("");
  };

  const resolveResetRequest = async (requestId: string) => {
    refreshFromResponse(
      await apiRequest({
        action: "resolve-reset",
        requestId,
      }),
    );
  };

  const saveDailyNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const student = activeStudents.find((user) => user.id === selectedStudentId);

    if (!student) {
      return;
    }

    refreshFromResponse(
      await apiRequest({
        action: "daily-note",
        note: dailyNote,
        userId: student.id,
      }),
    );
    setDailyNote("");
  };

  return (
    <main className="admin-shell">
      <header className="app-topbar">
        <div className="nav-brand">
          <Image src="/SA1.png" alt="SA1 logo" width={52} height={52} />
          <div>
            <p className="eyebrow">Admin Dashboard</p>
            <h1>Student performance control center</h1>
          </div>
        </div>
        <button type="button" className="leave-button" onClick={onLogout}>
          Logout
        </button>
      </header>

      <section className="admin-metrics">
        <div className="metric-card">
          <span>Active Students</span>
          <strong>{activeStudents.length}</strong>
        </div>
        <div className="metric-card">
          <span>Today Sessions</span>
          <strong>{todayResults.length}</strong>
        </div>
        <div className="metric-card">
          <span>Today Avg Score</span>
          <strong>{averageTodayScore}</strong>
        </div>
      </section>

      <section className="admin-grid">
        <form className="admin-card form-stack" onSubmit={createStudent}>
          <div>
            <p className="eyebrow">Create User</p>
            <h2>Student account</h2>
          </div>
          <label>
            Email
            <input
              required
              type="email"
              value={accountEmail}
              onChange={(event) => setAccountEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              minLength={6}
              required
              type="password"
              value={accountPassword}
              onChange={(event) => setAccountPassword(event.target.value)}
            />
          </label>
          <label>
            Student Level
            <select
              value={accountLevel}
              onChange={(event) => setAccountLevel(event.target.value)}
            >
              <option>Beginner</option>
              <option>Intermediate</option>
              <option>Advanced</option>
              <option>Testing</option>
            </select>
          </label>
          <button type="submit" className="call-button">
            Create Active Account
          </button>
        </form>

        <form className="admin-card form-stack" onSubmit={addManualResult}>
          <div>
            <p className="eyebrow">Daily Performance</p>
            <h2>Add result and notes</h2>
          </div>
          <StudentSelect
            students={activeStudents}
            value={selectedStudentId}
            onChange={setSelectedStudentId}
          />
          <label>
            Score
            <input
              max={100}
              min={0}
              required
              type="number"
              value={manualScore}
              onChange={(event) => setManualScore(event.target.value)}
            />
          </label>
          <label>
            Daily Result Notes
            <textarea
              required
              value={manualNotes}
              onChange={(event) => setManualNotes(event.target.value)}
            />
          </label>
          <button type="submit" className="call-button">
            Save Result
          </button>
        </form>

        <form className="admin-card form-stack" onSubmit={saveDailyNote}>
          <div>
            <p className="eyebrow">Daily Performance</p>
            <h2>Overall note</h2>
          </div>
          <StudentSelect
            students={activeStudents}
            value={selectedStudentId}
            onChange={setSelectedStudentId}
          />
          <label>
            Today&apos;s Overall Performance
            <textarea
              required
              value={dailyNote}
              onChange={(event) => setDailyNote(event.target.value)}
            />
          </label>
          <button type="submit" className="ghost-button">
            Save Daily Note
          </button>
        </form>

        <section className="admin-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Password Requests</p>
              <h2>Forgot password queue</h2>
            </div>
          </div>
          <div className="management-list">
            {data.resetRequests.length ? (
              data.resetRequests.map((request) => {
                const resetUser = data.users.find((user) => user.email === request.email);

                return (
                  <article key={request.id} className="management-row">
                    <div>
                      <strong>
                        {resetUser ? getUserDisplayName(resetUser) : request.email}
                      </strong>
                      <span>
                        {request.status === "resolved"
                          ? `Resolved: ${request.newPassword}`
                          : formatDate(request.createdAt)}
                      </span>
                    </div>
                    {request.status === "pending" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => resolveResetRequest(request.id)}
                      >
                        Generate Temp Password
                      </button>
                    ) : null}
                  </article>
                );
              })
            ) : (
              <div className="empty-panel">
                <p>No password reset requests.</p>
              </div>
            )}
          </div>
        </section>
      </section>

      <section className="admin-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">User Data</p>
            <h2>Manage students</h2>
          </div>
        </div>
        <div className="management-list">
          {students.length ? (
            students.map((student) =>
              editingStudentId === student.id ? (
                <form
                  key={student.id}
                  className="management-row management-edit-row"
                  onSubmit={saveStudentEdit}
                >
                  <label>
                    Name
                    <input
                      minLength={2}
                      required
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      required
                      type="email"
                      value={editEmail}
                      onChange={(event) => setEditEmail(event.target.value)}
                    />
                  </label>
                  <label>
                    Level
                    <select
                      value={editLevel}
                      onChange={(event) =>
                        setEditLevel(normalizeSpeakingLevel(event.target.value))
                      }
                    >
                      <option>Beginner</option>
                      <option>Intermediate</option>
                      <option>Advanced</option>
                      <option>Testing</option>
                    </select>
                  </label>
                  <label>
                    Status
                    <select
                      value={editStatus}
                      onChange={(event) =>
                        setEditStatus(event.target.value as AccountStatus)
                      }
                    >
                      <option value="active">Active</option>
                      <option value="pending">Pending</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </label>
                  <div className="row-actions">
                    <button type="submit" className="call-button">
                      Save
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={cancelEditStudent}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <article key={student.id} className="management-row">
                  <div className="student-identity">
                    <ProfileBadge user={student} />
                    <div>
                      <strong>{getUserDisplayName(student)}</strong>
                      <span>
                        {student.level} level · {student.status}
                      </span>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setDetailStudentId(student.id)}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => startEditStudent(student)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost-button danger-button"
                      onClick={() => deleteStudentAccount(student)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ),
            )
          ) : (
            <div className="empty-panel">
              <p>No student accounts yet.</p>
            </div>
          )}
        </div>
      </section>

      {detailStudent ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="student-detail-title"
        >
          <section className="admin-detail-modal detail-card">
            <div className="panel-heading">
              <div className="student-identity">
                <ProfileBadge user={detailStudent} />
                <div>
                  <p className="eyebrow">Student Detail</p>
                  <h2 id="student-detail-title">{getUserDisplayName(detailStudent)}</h2>
                  <span>
                    {detailStudent.level} level · {detailStudent.status}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setDetailStudentId("")}
              >
                Close
              </button>
            </div>

            <div className="admin-detail-scroll">
              <div className="quality-metrics">
                <div className="metric-card">
                  <span>Sessions</span>
                  <strong>{detailSummary.sessionCount}</strong>
                </div>
                <div className="metric-card">
                  <span>Average Score</span>
                  <strong>{detailSummary.averageScore}</strong>
                </div>
                <div className="metric-card">
                  <span>Today Sessions</span>
                  <strong>{detailSummary.todayCount}</strong>
                </div>
                <div className="metric-card">
                  <span>Today Average</span>
                  <strong>{detailSummary.todayAverage}</strong>
                </div>
              </div>
              {detailStudent.dailyPerformanceNote ? (
                <div className="recommendation-block">
                  <p className="feedback-label">Daily Note</p>
                  <p>{detailStudent.dailyPerformanceNote}</p>
                </div>
              ) : null}
              <ResultList
                results={detailResults}
                emptyText="No results recorded for this student."
                listClassName="admin-detail-result-list"
              />
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}

function StudentSelect({
  onChange,
  students,
  value,
}: {
  onChange: (value: string) => void;
  students: UserAccount[];
  value: string;
}) {
  return (
    <label>
      Student
      <select
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose student</option>
        {students.map((student) => (
          <option key={student.id} value={student.id}>
            {getUserDisplayName(student)}
          </option>
        ))}
      </select>
    </label>
  );
}

function TestingSession({
  categoryName,
  currentUser,
  onLeave,
  onSessionComplete,
}: {
  categoryName: SpeakingLevel;
  currentUser: UserAccount;
  onLeave: () => void;
  onSessionComplete: (result: SessionResult) => void;
}) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [sessionEndedAt, setSessionEndedAt] = useState<number | null>(null);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [speakerLevel, setSpeakerLevel] = useState(0);
  const [savedSessionId, setSavedSessionId] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState("");
  const [sessionStarting, setSessionStarting] = useState(false);

  const conversation = useConversation({
    onMessage: (payload) => {
      if (
        (payload.role !== "user" && payload.role !== "agent") ||
        (payload.source !== "user" && payload.source !== "ai") ||
        !payload.message
      ) {
        return;
      }

      const eventId = payload.event_id ?? Date.now();
      const entryId = `${payload.role}:${eventId}`;

      setTranscript((current) => {
        const existingIndex = current.findIndex((entry) => entry.entryId === entryId);
        const nextEntry: TranscriptEntry = {
          entryId,
          message: payload.message,
          role: payload.role,
          source: payload.source,
          timestamp: Date.now(),
        };

        if (existingIndex >= 0) {
          const next = [...current];
          next[existingIndex] = nextEntry;
          return next;
        }

        return [...current, nextEntry];
      });
    },
  });

  const {
    endSession,
    getInputVolume,
    getOutputVolume,
    isListening,
    isMuted,
    isSpeaking,
    setMuted,
    startSession,
    status,
  } = conversation;

  useEffect(() => {
    if (status !== "connected" || !sessionStartedAt) {
      return;
    }

    const timer = window.setInterval(() => {
      setSessionSeconds(
        Math.max(Math.round((Date.now() - sessionStartedAt) / 1000), 0),
      );
      setMicLevel(getInputVolume());
      setSpeakerLevel(getOutputVolume());
    }, 120);

    return () => window.clearInterval(timer);
  }, [getInputVolume, getOutputVolume, sessionStartedAt, status]);

  useEffect(() => {
    if (status !== "connecting") {
      return;
    }

    const timeout = window.setTimeout(() => {
      const message =
        "The speaking agent is taking too long to connect. Check the ElevenLabs agent ID/API key and try again.";

      setSessionNotice(message);
      setSessionStartedAt(null);
      setSessionEndedAt(null);
      setTranscript([
        {
          entryId: `agent:${Date.now()}`,
          message,
          role: "agent",
          source: "ai",
          timestamp: Date.now(),
        },
      ]);
      endSession();
    }, 15000);

    return () => window.clearTimeout(timeout);
  }, [endSession, status]);

  useEffect(() => {
    if (status === "connected" && !sessionStartedAt) {
      setSessionStartedAt(Date.now());
      setSessionEndedAt(null);
    }

    if (status === "disconnected" && sessionStartedAt && !sessionEndedAt) {
      setSessionEndedAt(Date.now());
    }
  }, [sessionEndedAt, sessionStartedAt, status]);

  const qualitySnapshot = useMemo(
    () => buildQualitySnapshot(transcript, sessionStartedAt, sessionEndedAt),
    [sessionEndedAt, sessionStartedAt, transcript],
  );
  const sortedTranscript = useMemo(
    () => [...transcript].sort((a, b) => a.timestamp - b.timestamp),
    [transcript],
  );
  const showPostCallFeedback = status === "disconnected" && !!sessionEndedAt;

  useEffect(() => {
    if (!showPostCallFeedback || savedSessionId) {
      return;
    }

    const resultId = createId("session");
    setSavedSessionId(resultId);
    onSessionComplete({
      ...qualitySnapshot,
      createdAt: sessionEndedAt ?? Date.now(),
      id: resultId,
      notes: `${categoryName} speaking test`,
      studentEmail: currentUser.email,
      studentId: currentUser.id,
      transcript: sortedTranscript,
    });
  }, [
    currentUser.email,
    currentUser.id,
    categoryName,
    onSessionComplete,
    qualitySnapshot,
    savedSessionId,
    sessionEndedAt,
    showPostCallFeedback,
    sortedTranscript,
  ]);

  const getSpeakingSessionOptions = async () => {
    try {
      const response = await fetch("/api/elevenlabs/signed-url", {
        cache: "no-store",
      });

      if (response.status === 501) {
        return {
          agentId: AGENT_ID,
          connectionType: "websocket" as const,
        };
      }

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        signedUrl?: string;
        signed_url?: string;
      };

      if (!response.ok) {
        throw new Error(
          payload.error || "Unable to prepare the ElevenLabs speaking session.",
        );
      }

      const signedUrl = payload.signedUrl ?? payload.signed_url;

      if (!signedUrl) {
        throw new Error("ElevenLabs did not return a signed speaking URL.");
      }

      return {
        signedUrl,
        connectionType: "websocket" as const,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error("Unable to prepare the ElevenLabs speaking session.");
    }
  };

  const showSessionError = (message: string) => {
    setSessionNotice(message);
    setSessionStartedAt(null);
    setSessionEndedAt(null);
    setTranscript([
      {
        entryId: `agent:${Date.now()}`,
        message,
        role: "agent",
        source: "ai",
        timestamp: Date.now(),
      },
    ]);
  };

  const handleStartSession = async () => {
    if (sessionStarting || status === "connecting") {
      return;
    }

    setSessionStarting(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      setTranscript([]);
      setSessionNotice("");
      setSessionStartedAt(null);
      setSessionEndedAt(null);
      setSessionSeconds(0);
      setSavedSessionId(null);

      const sessionOptions = await getSpeakingSessionOptions();

      startSession({
        ...sessionOptions,
        connectionType: "websocket",
        onConnect: () => {
          setSessionNotice("");
          setSessionStartedAt(Date.now());
          setSessionEndedAt(null);
        },
        onError: (message) => {
          const privateAgentHint =
            "agentId" in sessionOptions
              ? " If this ElevenLabs agent is private, add ELEVENLABS_API_KEY to .env.local and restart the dev server."
              : "";

          showSessionError(
            `${
              message ||
              "The speaking test could not connect. Check the ElevenLabs agent settings and try again."
            }${privateAgentHint}`,
          );
        },
      });
    } catch (error) {
      showSessionError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone access is blocked. Allow microphone permission and try again."
          : error instanceof Error
            ? error.message
            : "The speaking test could not connect. Try again in a moment.",
      );
    } finally {
      setSessionStarting(false);
    }
  };

  const handleEndSession = () => {
    setSessionNotice("");
    setSessionEndedAt(Date.now());
    endSession();
  };

  const handleLeave = () => {
    if (status === "connected" || status === "connecting") {
      endSession();
    }

    onLeave();
  };

  return (
    <section className="session-screen">
      <div className="session-topbar">
        <div className="student-identity">
          <ProfileBadge user={currentUser} />
          <div>
            <p className="eyebrow">Active Session</p>
            <h2>{categoryName} Category</h2>
            <span>{getUserDisplayName(currentUser)}</span>
          </div>
        </div>
        <button type="button" className="leave-button" onClick={handleLeave}>
          Leave
        </button>
      </div>

      <div className="session-frame-wrap session-flow-layout">
        <section className="live-stage">
          <div className="live-stage-copy">
            <p className="eyebrow">Voice Practice Stage</p>
            <h3>Speak directly in the large session box.</h3>
            <p>
              Start the agent here, keep the conversation going, then review the
              transcript and quality panel below.
            </p>
          </div>

          <div className="call-stage-card">
            <div className="call-stage-visual">
              <div
                className={`call-orb ${status === "connected" ? "call-orb-live" : ""}`}
              >
                <div className="call-orb-core" />
              </div>

              <div className="audio-meter-group">
                <div className="audio-meter-row">
                  <span>Mic</span>
                  <div className="audio-meter-track">
                    <span
                      className="audio-meter-fill"
                      style={{ width: `${Math.max(micLevel * 100, 4)}%` }}
                    />
                  </div>
                </div>
                <div className="audio-meter-row">
                  <span>Agent</span>
                  <div className="audio-meter-track">
                    <span
                      className="audio-meter-fill"
                      style={{ width: `${Math.max(speakerLevel * 100, 4)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="call-stage-status">
              <div className="stage-status-pill">
                {status === "connected"
                  ? isSpeaking
                    ? "Agent Speaking"
                    : isListening
                      ? "Listening"
                      : "Connected"
                  : status === "error"
                    ? "Connection Issue"
                  : status === "connecting"
                    ? "Connecting"
                    : "Ready"}
              </div>
              <strong>{formatClock(sessionSeconds)}</strong>
            </div>

            <div className="call-stage-actions">
              {status === "connected" ? (
                <button
                  type="button"
                  className="call-button call-button-end"
                  onClick={handleEndSession}
                >
                  End Session
                </button>
              ) : (
                <button
                  type="button"
                  className="call-button"
                  onClick={handleStartSession}
                  disabled={sessionStarting || status === "connecting"}
                >
                  {sessionStarting || status === "connecting"
                    ? "Connecting..."
                    : "Start Speaking"}
                </button>
              )}

              <button
                type="button"
                className="ghost-button"
                onClick={() => setMuted(!isMuted)}
                disabled={status !== "connected"}
              >
                {isMuted ? "Unmute Mic" : "Mute Mic"}
              </button>
            </div>

            {sessionNotice ? (
              <p className="form-message session-connection-message">
                {sessionNotice}
              </p>
            ) : null}
          </div>
        </section>

        <div className="session-content-grid">
          <section className="transcript-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Conversation</p>
                <h3>Transcript</h3>
              </div>
              <span className="panel-badge">{sortedTranscript.length} turns</span>
            </div>

            <div className="transcript-list">
              {sortedTranscript.length ? (
                sortedTranscript.map((entry) => (
                  <article
                    key={entry.entryId}
                    className={`transcript-bubble transcript-${entry.role}`}
                  >
                    <span className="transcript-role">
                      {entry.role === "user" ? "You" : "Agent"}
                    </span>
                    <p>{entry.message}</p>
                  </article>
                ))
              ) : (
                <div className="empty-panel">
                  <p>The conversation transcript will appear here.</p>
                </div>
              )}
            </div>
          </section>

          <aside className="quality-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Conversation Quality</p>
                <h3>{showPostCallFeedback ? qualitySnapshot.label : "Available After Call"}</h3>
              </div>
              {showPostCallFeedback ? (
                <span className="quality-score">{qualitySnapshot.overallScore}</span>
              ) : null}
            </div>

            {showPostCallFeedback ? (
              <>
                <div className="quality-metrics">
                  <div className="metric-card">
                    <span>Duration</span>
                    <strong>{formatClock(qualitySnapshot.durationSeconds)}</strong>
                  </div>
                  <div className="metric-card">
                    <span>Learner Turns</span>
                    <strong>{qualitySnapshot.learnerTurns}</strong>
                  </div>
                  <div className="metric-card">
                    <span>Avg Words / Turn</span>
                    <strong>{qualitySnapshot.averageWordsPerTurn.toFixed(1)}</strong>
                  </div>
                  <div className="metric-card">
                    <span>Balance</span>
                    <strong>{Math.round(qualitySnapshot.balanceRatio * 100)}%</strong>
                  </div>
                </div>

                <div className="recommendation-block">
                  <p className="feedback-label">Practice Notes</p>
                  <ul>
                    {qualitySnapshot.recommendations.map((recommendation) => (
                      <li key={recommendation}>{recommendation}</li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div className="empty-panel quality-empty">
                <p>
                  Finish the call first. Conversation feedback and quality notes
                  will appear here after the session ends.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [data, setData] = useState<StoredData>(() => createDefaultData());
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [progress, setProgress] = useState(0);
  const [view, setView] = useState<ViewState>("loading");
  const [selectedCategory, setSelectedCategory] = useState<SpeakingLevel>("Beginner");
  const [ready, setReady] = useState(false);
  const [databaseError, setDatabaseError] = useState("");

  const setAndPersistData = (nextData: StoredData) => {
    setData(nextData);
  };

  useEffect(() => {
    async function loadData() {
      try {
        const response = await apiRequest();
        const storedData = response.data ?? createDefaultData();
        const storedUserId = getPersistedUserId();
        const storedUser = storedData.users.find(
          (user) => user.id === storedUserId && user.status === "active",
        );

        setData(storedData);
        if (storedUser) {
          setSelectedCategory(normalizeSpeakingLevel(storedUser.level));
        }
        setCurrentUser(storedUser ?? null);
        setDatabaseError("");
      } catch (error) {
        setDatabaseError(
          error instanceof Error
            ? error.message
            : "The database could not be reached.",
        );
      } finally {
        setReady(true);
      }
    }

    loadData();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 100) {
          window.clearInterval(timer);
          return 100;
        }

        return Math.min(current + 5, 100);
      });
    }, 90);

    const finishTimer = window.setTimeout(() => {
      setView("home");
    }, 2200);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(finishTimer);
    };
  }, []);

  useEffect(() => {
    if (view !== "portal" && view !== "leaving") {
      return;
    }

    const portalTimer = window.setTimeout(() => {
      setView(view === "portal" ? "session" : "home");
    }, view === "portal" ? 1400 : 1050);

    return () => window.clearTimeout(portalTimer);
  }, [view]);

  const latestCurrentUser = currentUser
    ? data.users.find((user) => user.id === currentUser.id) ?? currentUser
    : null;

  const handleLogin = (user: UserAccount) => {
    persistUserId(user.id);
    setSelectedCategory(normalizeSpeakingLevel(user.level));
    setCurrentUser(user);
    setView("home");
  };

  const handleLogout = () => {
    clearPersistedUserId();
    setCurrentUser(null);
    setSelectedCategory("Beginner");
    setView("home");
  };

  const openPortal = (categoryName: SpeakingLevel) => {
    if (!latestCurrentUser || !canAccessCategory(latestCurrentUser, categoryName)) {
      return;
    }

    setSelectedCategory(categoryName);
    setView("portal");
  };

  const updateCurrentName = async (name: string) => {
    if (!latestCurrentUser) {
      return;
    }

    const response = await apiRequest({
      action: "update-name",
      name,
      userId: latestCurrentUser.id,
    });

    if (response.data) {
      setAndPersistData(response.data);
      const updatedUser = response.data.users.find(
        (user) => user.id === latestCurrentUser.id,
      );
      setCurrentUser(updatedUser ?? latestCurrentUser);
    }
  };

  const uploadCurrentProfileImage = async (profileImage: string) => {
    if (!latestCurrentUser) {
      return;
    }

    const response = await apiRequest({
      action: "profile-image",
      profileImage,
      userId: latestCurrentUser.id,
    });

    if (response.data) {
      setAndPersistData(response.data);
      const updatedUser = response.data.users.find(
        (user) => user.id === latestCurrentUser.id,
      );
      setCurrentUser(updatedUser ?? latestCurrentUser);
    }
  };

  const saveSessionResult = async (result: SessionResult) => {
    let scoredResult = result;

    try {
      scoredResult = await getAiFeedbackResult(result);
    } catch {
      scoredResult = result;
    }

    const response = await apiRequest({
      action: "save-result",
      result: scoredResult,
    });

    if (response.data) {
      setAndPersistData(response.data);
    }
  };

  if (!ready || (view === "loading" && !databaseError)) {
    return (
      <main className="app-shell">
        <section className="loading-screen">
          <div className="loading-card">
            <div className="loading-image-wrap">
              <Image
                src="/SA1.png"
                alt="SA1 logo"
                width={220}
                height={220}
                priority
              />
            </div>
            <div className="loading-copy">
              <p className="eyebrow">Speaking Budy</p>
              <h1>Warming up your English practice space</h1>
              <p>
                Loading your speaking portal, accounts, and performance
                dashboard.
              </p>
            </div>
            <div className="progress-block" aria-label="Loading progress">
              <div className="progress-track">
                <span
                  className="progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <strong>{progress}%</strong>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (databaseError) {
    return <DatabaseSetupScreen message={databaseError} />;
  }

  if (!latestCurrentUser) {
    return (
      <AuthScreen
        onDataChange={setAndPersistData}
        onLogin={handleLogin}
      />
    );
  }

  if (latestCurrentUser.role === "admin") {
    return (
      <AdminDashboard
        data={data}
        onDataChange={setAndPersistData}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <main className="app-shell">
      {view === "home" ? (
        <StudentHome
          currentUser={latestCurrentUser}
          onChangeName={updateCurrentName}
          onLogout={handleLogout}
          onOpenPortal={openPortal}
          onProfileImage={uploadCurrentProfileImage}
          results={data.results.filter(
            (result) => result.studentId === latestCurrentUser.id,
          )}
        />
      ) : null}

      {view === "portal" ? (
        <section className="portal-screen" aria-live="polite">
          <div className="portal-ring portal-ring-a" />
          <div className="portal-ring portal-ring-b" />
          <div className="portal-core" />
          <div className="portal-copy">
            <p className="eyebrow">{selectedCategory} Portal</p>
            <h2>Passing through the speaking gateway</h2>
          </div>
        </section>
      ) : null}

      {view === "leaving" ? (
        <section className="portal-screen portal-screen-exit" aria-live="polite">
          <div className="portal-ring portal-ring-a" />
          <div className="portal-ring portal-ring-b" />
          <div className="portal-core" />
          <div className="portal-copy">
            <p className="eyebrow">{selectedCategory} Portal</p>
            <h2>Returning to your practice dashboard</h2>
          </div>
        </section>
      ) : null}

      {view === "session" ? (
        <ConversationProvider>
          <TestingSession
            categoryName={selectedCategory}
            currentUser={latestCurrentUser}
            onLeave={() => setView("leaving")}
            onSessionComplete={saveSessionResult}
          />
        </ConversationProvider>
      ) : null}
    </main>
  );
}
