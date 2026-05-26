import { NextRequest, NextResponse } from "next/server";
import type { SessionResult, TranscriptEntry } from "@/lib/shared";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

type FeedbackBody = {
  result?: SessionResult;
};

type AiFeedback = {
  averageWordsPerTurn?: number;
  balanceRatio?: number;
  durationSeconds?: number;
  gapFeedback?: string;
  label?: string;
  learnerTurns?: number;
  overallScore?: number;
  recommendations?: string[];
  totalTurns?: number;
  weakWords?: string[];
};

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return Math.max(min, Math.min(numberValue, max));
}

function clampScore(score: unknown, fallback: number) {
  return Math.round(clampNumber(score, 0, 100, fallback));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  return Math.round(clampNumber(value, min, max, fallback));
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

function extractWeakWords(transcript: TranscriptEntry[]) {
  const fillerPattern = /\b(?:um+|uh+|erm+|ah+|hmm+|mmm+|like|you know)\b|\.{2,}/gi;
  const counts = new Map<string, number>();

  for (const entry of transcript) {
    if (entry.role !== "user") {
      continue;
    }

    for (const match of entry.message.matchAll(fillerPattern)) {
      const weakWord = match[0].toLowerCase();

      counts.set(weakWord, (counts.get(weakWord) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word, count]) => (count > 1 ? `${word} (${count}x)` : word));
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as FeedbackBody;
  const result = body.result;

  if (!result) {
    return NextResponse.json({ error: "Missing result payload." }, { status: 400 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    const weakWords = extractWeakWords(result.transcript ?? []);

    return NextResponse.json({
      result: {
        ...fallbackFeedback(result),
        gapFeedback: weakWords.length
          ? "Frequent filler sounds and pauses made the answer feel hesitant. Replace them with a short silent pause, then continue with a complete sentence."
          : result.gapFeedback,
        weakWords,
      },
      warning: "OPENROUTER_API_KEY is not configured; local participation rule was applied.",
    });
  }

  const participation = getParticipation(result);
  const model = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;

  const response = await fetch(OPENROUTER_API_URL, {
    body: JSON.stringify({
      messages: [
        {
          content:
            "You are a strict but helpful English speaking-test evaluator. Return JSON only. Calculate the participation metrics directly from the transcript. Give honest practice feedback based on the student's actual speaking, not encouragement. If the student speaks less than the agent or uses fewer words than the agent, the score must be 50 or lower.",
          role: "system",
        },
        {
          content: JSON.stringify({
            instruction:
              "Assess this speaking practice. Return exactly { overallScore: number, durationSeconds: number, learnerTurns: number, totalTurns: number, averageWordsPerTurn: number, balanceRatio: number, weakWords: string[], gapFeedback: string, label: string, recommendations: string[] }. Count only Student lines as learner turns. totalTurns is all Student plus Agent lines. averageWordsPerTurn is total student words divided by learnerTurns. balanceRatio is min(student turns, agent turns) divided by max(student turns, agent turns), or 0 when one side has no turns. weakWords must spotlight the student's repeated filler words, weak phrases, hesitation markers, and long-gap markers from the transcript, especially umm, uh, hmm, mmm, like, you know, and '...'; include counts when repeated. gapFeedback must be an honest 1-2 sentence comment about hesitation, pauses, filler words, and speaking confidence. Use providedDurationSeconds as durationSeconds unless the transcript clearly proves a better value. The label must be one strong conversation quality feedback sentence, max 140 characters. Recommendations must be 3 direct improvement actions that match the weakWords and gapFeedback.",
            providedDurationSeconds: result.durationSeconds,
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
  const nextLearnerTurns = clampInteger(
    feedback.learnerTurns,
    0,
    result.transcript?.length ?? result.totalTurns,
    result.learnerTurns,
  );
  const nextTotalTurns = clampInteger(
    feedback.totalTurns,
    nextLearnerTurns,
    result.transcript?.length ?? Math.max(result.totalTurns, nextLearnerTurns),
    result.totalTurns,
  );
  const nextAverageWordsPerTurn = clampNumber(
    feedback.averageWordsPerTurn,
    0,
    1000,
    result.averageWordsPerTurn,
  );
  const nextBalanceRatio = clampNumber(
    feedback.balanceRatio,
    0,
    1,
    result.balanceRatio,
  );
  const nextDurationSeconds = clampInteger(
    feedback.durationSeconds,
    0,
    24 * 60 * 60,
    result.durationSeconds,
  );
  const scoreCap = participation.learnerTalkedLess ? 50 : 100;
  const nextScore = Math.min(
    clampScore(feedback.overallScore, result.overallScore),
    scoreCap,
  );
  const nextRecommendations =
    feedback.recommendations?.filter(Boolean).slice(0, 3) ??
    result.recommendations;
  const weakWords =
    feedback.weakWords
      ?.map((word) => word.trim())
      .filter(Boolean)
      .slice(0, 8) ?? extractWeakWords(result.transcript ?? []);
  const gapFeedback =
    feedback.gapFeedback?.trim() ||
    (weakWords.length
      ? "Filler words and long pauses made parts of the answer sound hesitant. Pause silently, then restart with a clearer full sentence."
      : result.gapFeedback);

  return NextResponse.json({
    result: {
      ...result,
      averageWordsPerTurn: nextAverageWordsPerTurn,
      balanceRatio: nextBalanceRatio,
      durationSeconds: nextDurationSeconds,
      gapFeedback,
      label:
        feedback.label?.trim() ||
        (participation.learnerTalkedLess
          ? "Low learner participation: answers were too short and agent-led."
          : result.label),
      learnerTurns: nextLearnerTurns,
      overallScore: nextScore,
      recommendations: nextRecommendations.length
        ? nextRecommendations
        : result.recommendations,
      totalTurns: nextTotalTurns,
      weakWords,
    },
  });
}
