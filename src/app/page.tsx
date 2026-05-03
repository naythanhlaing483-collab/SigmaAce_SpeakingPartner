"use client";

import {
  ConversationProvider,
  useConversation,
} from "@elevenlabs/react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

const AGENT_ID = "agent_3901kge88pyjfgftr735d40j1x4v";

const categories = [
  {
    name: "Testing",
    status: "Unlocked",
    description: "Jump into the live speaking test portal.",
    unlocked: true,
  },
  {
    name: "Beginner",
    status: "Coming Soon",
    description: "Daily basics, slow prompts, and confidence drills.",
    unlocked: false,
  },
  {
    name: "Intermediate",
    status: "Coming Soon",
    description: "Conversational practice with structure and feedback.",
    unlocked: false,
  },
  {
    name: "Advanced",
    status: "Coming Soon",
    description: "High-speed discussions, nuance, and fluency challenges.",
    unlocked: false,
  },
] as const;

type ViewState = "loading" | "home" | "portal" | "session";

type TranscriptEntry = {
  entryId: string;
  message: string;
  role: "user" | "agent";
  source: "user" | "ai";
  timestamp: number;
};

type QualitySnapshot = {
  averageWordsPerTurn: number;
  balanceRatio: number;
  durationSeconds: number;
  label: string;
  learnerTurns: number;
  overallScore: number;
  recommendations: string[];
  totalTurns: number;
};

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
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

function TestingSession({ onLeave }: { onLeave: () => void }) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [sessionEndedAt, setSessionEndedAt] = useState<number | null>(null);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [speakerLevel, setSpeakerLevel] = useState(0);

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

  const handleStartSession = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());

      setTranscript([]);
      setSessionStartedAt(Date.now());
      setSessionEndedAt(null);
      setSessionSeconds(0);

      startSession({
        agentId: AGENT_ID,
        connectionType: "websocket",
      });
    } catch {
      setTranscript([
        {
          entryId: `agent:${Date.now()}`,
          message:
            "Microphone access is blocked. Allow microphone permission and try again.",
          role: "agent",
          source: "ai",
          timestamp: Date.now(),
        },
      ]);
    }
  };

  const handleEndSession = () => {
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
        <div>
          <p className="eyebrow">Active Session</p>
          <h2>Testing Category</h2>
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
                >
                  Start Speaking
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
  const [progress, setProgress] = useState(0);
  const [view, setView] = useState<ViewState>("loading");

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
    if (view !== "portal") {
      return;
    }

    const portalTimer = window.setTimeout(() => {
      setView("session");
    }, 1400);

    return () => window.clearTimeout(portalTimer);
  }, [view]);

  const openTestingPortal = () => {
    setView("portal");
  };

  const leaveSession = () => {
    setView("home");
  };

  return (
    <main className="app-shell">
      {view === "loading" ? (
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
              <p className="eyebrow">Flashy Learn</p>
              <h1>Warming up your English practice space</h1>
              <p>
                Loading your speaking portal, level tracks, and practice
                experience.
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
      ) : null}

      {view === "home" ? (
        <section className="home-screen">
          <div className="hero-panel">
            <p className="eyebrow">Pick Your Practice Path</p>
            <h1>English speaking practice built for teen learners.</h1>
            <p className="hero-text">
              Start from the live testing portal today. Other level-based
              categories are shown below and remain locked for now.
            </p>
          </div>

          <div className="category-grid">
            {categories.map((category) =>
              category.unlocked ? (
                <button
                  key={category.name}
                  type="button"
                  className="category-card category-card-active"
                  onClick={openTestingPortal}
                >
                  <span className="category-status">{category.status}</span>
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
                  <span className="category-status">{category.status}</span>
                  <h2>{category.name}</h2>
                  <p>{category.description}</p>
                  <span className="category-action">Locked</span>
                </div>
              ),
            )}
          </div>
        </section>
      ) : null}

      {view === "portal" ? (
        <section className="portal-screen" aria-live="polite">
          <div className="portal-ring portal-ring-a" />
          <div className="portal-ring portal-ring-b" />
          <div className="portal-core" />
          <div className="portal-copy">
            <p className="eyebrow">Testing Portal</p>
            <h2>Passing through the speaking gateway</h2>
          </div>
        </section>
      ) : null}

      {view === "session" ? (
        <ConversationProvider>
          <TestingSession onLeave={leaveSession} />
        </ConversationProvider>
      ) : null}
    </main>
  );
}
