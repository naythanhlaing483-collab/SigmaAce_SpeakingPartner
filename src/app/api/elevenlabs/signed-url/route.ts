import { NextResponse } from "next/server";

const DEFAULT_AGENT_ID = "agent_3901kge88pyjfgftr735d40j1x4v";
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

function getErrorMessage(payload: unknown) {
  if (payload && typeof payload === "object") {
    const body = payload as { detail?: unknown; error?: unknown; message?: unknown };
    const message = body.detail ?? body.error ?? body.message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return "Unable to create an ElevenLabs speaking session.";
}

export async function GET() {
  const agentId =
    process.env.ELEVENLABS_AGENT_ID ??
    process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ??
    DEFAULT_AGENT_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        configured: false,
        error:
          "ELEVENLABS_API_KEY is not configured. Public agent connection fallback is required.",
      },
      { status: 501 },
    );
  }

  try {
    const response = await fetch(
      `${ELEVENLABS_API_BASE}/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`,
      {
        cache: "no-store",
        headers: {
          "xi-api-key": apiKey,
        },
      },
    );
    const payload = (await response.json()) as unknown;

    if (!response.ok) {
      return NextResponse.json(
        { error: getErrorMessage(payload) },
        { status: response.status },
      );
    }

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
