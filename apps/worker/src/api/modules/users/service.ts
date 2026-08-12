import { TelegramClient } from "@worker/clients/telegram";
import { getOwnAccounts } from "@worker/db/accounts";
import {
  approveUser,
  deleteUser,
  getNonAdminUsers,
  getUserByTelegramId,
  rejectUser,
} from "@worker/db/users";
import { t } from "@worker/i18n";
import type { Env, TelegramUser } from "@worker/types";
import { cleanupAndDeleteAccount } from "@worker/utils/accounts";
import { reportErrorToObservability } from "@worker/utils/observability";
import type { UserListResponse, UserResponse } from "./model";
import { userToResponse } from "./utils";

type UserResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 403 | 404; error: string };

export abstract class UsersService {
  static async listUsers(
    env: Env,
    isAdmin: boolean,
  ): Promise<UserResult<UserListResponse>> {
    if (!isAdmin) return { ok: false, status: 403, error: "Forbidden" };

    const users = await getNonAdminUsers(env.DB, env.ADMIN_TELEGRAM_ID);
    const rows = await Promise.all(
      users.map(async (user) =>
        userToResponse(
          user,
          (await getOwnAccounts(env.DB, user.telegram_id)).length,
        ),
      ),
    );
    return { ok: true, data: { users: rows } };
  }

  static async approveUser(
    env: Env,
    isAdmin: boolean,
    targetId: string,
  ): Promise<UserResult<UserResponse>> {
    const target = await UsersService.requireTargetUser(env, isAdmin, targetId);
    if (!target.ok) return target;

    await approveUser(env.DB, target.data.telegram_id);
    await UsersService.notifyUser(
      env,
      target.data.telegram_id,
      t("start:approvedNotify"),
    );
    return UsersService.getUserResponse(env, target.data.telegram_id);
  }

  static async revokeUser(
    env: Env,
    isAdmin: boolean,
    targetId: string,
  ): Promise<UserResult<UserResponse>> {
    const target = await UsersService.requireTargetUser(env, isAdmin, targetId);
    if (!target.ok) return target;

    await rejectUser(env.DB, target.data.telegram_id);
    await UsersService.notifyUser(
      env,
      target.data.telegram_id,
      t("start:revokedNotify"),
    );
    return UsersService.getUserResponse(env, target.data.telegram_id);
  }

  static async deleteUser(
    env: Env,
    isAdmin: boolean,
    targetId: string,
  ): Promise<UserResult<{ ok: true }>> {
    const target = await UsersService.requireTargetUser(env, isAdmin, targetId);
    if (!target.ok) return target;

    const accounts = await getOwnAccounts(env.DB, target.data.telegram_id);
    for (const account of accounts) {
      await cleanupAndDeleteAccount(env, account);
    }
    await deleteUser(env.DB, target.data.telegram_id);
    return { ok: true, data: { ok: true } };
  }

  private static async getUserResponse(
    env: Env,
    telegramId: string,
  ): Promise<UserResult<UserResponse>> {
    const user = await getUserByTelegramId(env.DB, telegramId);
    if (!user) return { ok: false, status: 404, error: "User not found" };
    const accounts = await getOwnAccounts(env.DB, telegramId);
    return { ok: true, data: userToResponse(user, accounts.length) };
  }

  private static async requireTargetUser(
    env: Env,
    isAdmin: boolean,
    targetId: string,
  ): Promise<UserResult<TelegramUser>> {
    if (!isAdmin) return { ok: false, status: 403, error: "Forbidden" };
    if (targetId === env.ADMIN_TELEGRAM_ID) {
      return { ok: false, status: 400, error: "Cannot manage admin user" };
    }

    const user = await getUserByTelegramId(env.DB, targetId);
    if (!user) return { ok: false, status: 404, error: "User not found" };
    return { ok: true, data: user };
  }

  private static async notifyUser(
    env: Env,
    telegramId: string,
    message: string,
  ): Promise<void> {
    try {
      await new TelegramClient(env).sendTextMessage(telegramId, message);
    } catch (err) {
      await reportErrorToObservability(env, "users.notify_user_failed", err, {
        telegramUserId: telegramId,
      });
    }
  }
}
