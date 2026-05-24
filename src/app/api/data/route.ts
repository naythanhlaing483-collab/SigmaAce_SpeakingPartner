import { NextRequest, NextResponse } from "next/server";
import {
  changePassword,
  createStudent,
  deleteStudent,
  getData,
  login,
  requestPasswordReset,
  resolveReset,
  saveDailyNote,
  saveResult,
  updateUserName,
  updateStudent,
  updateProfileImage,
  updateUserStatus,
} from "@/lib/store";
import type { AccountStatus } from "@/lib/shared";

type ActionBody = {
  action?: string;
  email?: string;
  level?: string;
  name?: string;
  note?: string;
  password?: string;
  profileImage?: string;
  requestId?: string;
  result?: Parameters<typeof saveResult>[0];
  status?: AccountStatus;
  userId?: string;
};

function ok(data: object = {}) {
  return NextResponse.json({ ok: true, ...data });
}

function getErrorMessage(error: unknown) {
  if (error instanceof AggregateError) {
    const messages = error.errors
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .filter(Boolean);

    if (messages.length) {
      return messages.join(" ");
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Request failed.";
}

function fail(error: unknown, status = 400) {
  const message = getErrorMessage(error);

  return NextResponse.json({ error: message }, { status });
}

export async function GET() {
  try {
    return ok({ data: await getData() });
  } catch (error) {
    return fail(error, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ActionBody;

    switch (body.action) {
      case "login":
        return ok({
          data: await getData(),
          user: await login(body.email ?? "", body.password ?? ""),
        });

      case "forgot":
        await requestPasswordReset(body.email ?? "");
        return ok({ data: await getData() });

      case "create-student":
        await createStudent(body.email ?? "", body.password ?? "", body.level ?? "Beginner");
        return ok({ data: await getData() });

      case "update-user-status":
        await updateUserStatus(body.userId ?? "", body.status ?? "pending");
        return ok({ data: await getData() });

      case "update-student":
        await updateStudent(body.userId ?? "", {
          email: body.email ?? "",
          level: body.level ?? "Beginner",
          name: body.name ?? "",
          status: body.status ?? "active",
        });
        return ok({ data: await getData() });

      case "delete-student":
        await deleteStudent(body.userId ?? "");
        return ok({ data: await getData() });

      case "change-password":
        await changePassword(body.userId ?? "", body.password ?? "");
        return ok({ data: await getData() });

      case "update-name":
        await updateUserName(body.userId ?? "", body.name ?? "");
        return ok({ data: await getData() });

      case "profile-image":
        await updateProfileImage(body.userId ?? "", body.profileImage ?? "");
        return ok({ data: await getData() });

      case "daily-note":
        await saveDailyNote(body.userId ?? "", body.note ?? "");
        return ok({ data: await getData() });

      case "save-result":
        if (!body.result) {
          throw new Error("Missing result payload.");
        }
        await saveResult(body.result);
        return ok({ data: await getData() });

      case "resolve-reset":
        await resolveReset(body.requestId ?? "");
        return ok({ data: await getData() });

      default:
        throw new Error("Unknown action.");
    }
  } catch (error) {
    return fail(error);
  }
}
