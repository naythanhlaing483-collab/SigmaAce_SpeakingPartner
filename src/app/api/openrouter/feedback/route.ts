import { NextRequest, NextResponse } from "next/server";
import type { SessionResult, TranscriptEntry } from "@/lib/shared";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

type FeedbackBody = {
  result?: SessionResult;
};

type AiFeedback = {
  label?: string;
  overallScore?: number;
  recommendations?: string[];
};

function clampScore(score: unknown) {
  const value = typeof score === "number" && Number.isFinite(score) ? score : 0;

  return Math.max(0, Math.min(Math.round(value), 100));
}

function countWords(entries: TranscriptEntry[]) {
  return entries.reduce(
    (total, entry) =>
      total + entry.message.trim().split(/\s+/).filter(Boolean).length,
    0,
  );
}

function getParticipation(result: SessionResult) {
  const transcript = result.transcript ?? [];
  const learnerTurns = transcript.filter((entry) => entry.role === "user");
  const agentTurns = transcript.filter((entry) => entry.role === "agent");
  const learnerWords = countWords(learnerTurns);
  const agentWords = countWords(agentTurns);

  return {
    agentTurns: agentTurns.length,
    agentWords,
    learnerTalkedLess:
      learnerTurns.length < agentTurns.length || learnerWords < agentWords,
    learnerTurns: learnerTurns.length,
    learnerWords,
  };
}

function fallbackFeedback(result: SessionResult): SessionResult {
  const participation = getParticipation(result);

  if (!participation.learnerTalkedLess) {
    return result;
  }

  return {
    ...result,
    label:
      "Low learner participation: answers were too short and the agent carried the conversation.",
    overallScore: Math.min(result.overallScore, 50),
    recommendations: [
      "Speak more than the agent by giving longer answers with reasons and examples.",
      "Avoid one-word or very short replies; aim for two complete sentences each turn.",
      "Ask one follow-up question so the practice becomes a real conversation.",
    ],
  };
}

function safeJsonParse(content: string): AiFeedback {
  try {
    return JSON.parse(content) as AiFeedback;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);

    if (!match) {
      return {};
    }

    try {
      return JSON.parse(match[0]) as AiFeedback;
    } catch {
      return {};
    }
  }
}

function buildTranscriptText(transcript: TranscriptEntry[]) {
  return transcript
    .slice(-24)
    .map((entry) => `${entry.role === "user" ? "Student" : "Agent"}: ${entry.message}`)
    .join("\n")
    .slice(0, 8000);
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as FeedbackBody;
  const result = body.result;

  if (!result) {
    return NextResponse.json({ error: "Missing result payload." }, { status: 400 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      result: fallbackFeedback(result),
      warning: "OPENROUTER_API_KEY is not configured; local participation rule was applied.",
    });
  }

  const participation = getParticipation(result);
  const scoreCap = participation.learnerTalkedLess ? 50 : 100;
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;

  const response = await fetch(OPENROUTER_API_URL, {
    body: JSON.stringify({
      messages: [
        {
          content:
            "You are a strict but helpful English speaking-test evaluator. Return JSON only. Give honest practice feedback based on the student's actual speaking, not encouragement. If the student speaks less than the agent or uses fewer words than the agent, the score must be 50 or lower.",
          role: "system",
        },
        {
          content: JSON.stringify({
            instruction:
              "Assess this speaking practice. Return { overallScore: number, label: string, recommendations: string[] }. The label must be one strong conversation quality feedback sentence, max 140 characters. Recommendations must be 3 direct improvement actions.",
            metrics: {
              agentTurns: participation.agentTurns,
              agentWords: participation.agentWords,
              averageWordsPerTurn: result.averageWordsPerTurn,
              balanceRatio: result.balanceRatio,
              durationSeconds: result.durationSeconds,
              learnerTalkedLess: participation.learnerTalkedLess,
              learnerTurns: participation.learnerTurns,
              learnerWords: participation.learnerWords,
              scoreCap,
            },
            transcript: buildTranscriptText(result.transcript ?? []),
          }),
          role: "user",
        },
      ],
      model,
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Speaking Budy",
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (!response.ok) {
    return NextResponse.json(
      {
        error: payload.error?.message || "OpenRouter feedback request failed.",
        result: fallbackFeedback(result),
      },
      { status: response.status },
    );
  }

  const content = payload.choices?.[0]?.message?.content ?? "";
  const feedback = safeJsonParse(content);
  const nextScore = Math.min(
    clampScore(feedback.overallScore ?? result.overallScore),
    scoreCap,
  );
  const nextRecommendations =
    feedback.recommendations?.filter(Boolean).slice(0, 3) ??
    result.recommendations;

  return NextResponse.json({
    result: {
      ...result,
      label:
        feedback.label?.trim() ||
        (participation.learnerTalkedLess
          ? "Low learner participation: answers were too short and agent-led."
          : result.label),
      overallScore: nextScore,
      recommendations: nextRecommendations.length
        ? nextRecommendations
        : result.recommendations,
    },
  });
}
