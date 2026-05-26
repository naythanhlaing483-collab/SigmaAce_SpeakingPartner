export const DEFAULT_ADMIN_EMAIL = "admin@sigmaace.local";
export const DEFAULT_ADMIN_PASSWORD = "Admin@12345";

export type AccountRole = "admin" | "student";
export type AccountStatus = "active" | "pending" | "rejected";

export type UserAccount = {
  createdAt: number;
  dailyPerformanceNote?: string;
  email: string;
  id: string;
  level: string;
  name: string;
  nameChanged: boolean;
  profileImage?: string;
  profileImageChanged: boolean;
  role: AccountRole;
  status: AccountStatus;
};

export type TranscriptEntry = {
  entryId: string;
  message: string;
  role: "user" | "agent";
  source: "user" | "ai";
  timestamp: number;
};

export type ConversationMessage = TranscriptEntry & {
  sessionResultId: string;
  studentEmail: string;
  studentId: string;
};

export type QualitySnapshot = {
  averageWordsPerTurn: number;
  balanceRatio: number;
  durationSeconds: number;
  gapFeedback?: string;
  label: string;
  learnerTurns: number;
  overallScore: number;
  recommendations: string[];
  totalTurns: number;
  weakWords?: string[];
};

export type SessionResult = QualitySnapshot & {
  createdAt: number;
  id: string;
  notes?: string;
  studentEmail: string;
  studentId: string;
  transcript: TranscriptEntry[];
};

export type PasswordResetRequest = {
  createdAt: number;
  email: string;
  id: string;
  newPassword?: string;
  status: "pending" | "resolved";
};

export type StoredData = {
  conversationMessages?: ConversationMessage[];
  resetRequests: PasswordResetRequest[];
  results: SessionResult[];
  users: UserAccount[];
};

export function getDefaultUserName(email: string) {
  return email.split("@")[0]?.trim() || "User";
}

export function getUserDisplayName(user: Pick<UserAccount, "email" | "name">) {
  return user.name?.trim() || getDefaultUserName(user.email);
}
