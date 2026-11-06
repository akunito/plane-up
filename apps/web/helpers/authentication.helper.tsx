/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import Link from "next/link";
// plane imports
import { SUPPORT_EMAIL } from "@plane/constants";
// services
import { asRequestFailure } from "@/services/api.service";

export enum EPageTypes {
  PUBLIC = "PUBLIC",
  NON_AUTHENTICATED = "NON_AUTHENTICATED",
  SET_PASSWORD = "SET_PASSWORD",
  ONBOARDING = "ONBOARDING",
  AUTHENTICATED = "AUTHENTICATED",
}

export enum EAuthModes {
  SIGN_IN = "SIGN_IN",
  SIGN_UP = "SIGN_UP",
}

export enum EAuthSteps {
  EMAIL = "EMAIL",
  PASSWORD = "PASSWORD",
  UNIQUE_CODE = "UNIQUE_CODE",
}

export enum EErrorAlertType {
  BANNER_ALERT = "BANNER_ALERT",
  INLINE_FIRST_NAME = "INLINE_FIRST_NAME",
  INLINE_EMAIL = "INLINE_EMAIL",
  INLINE_PASSWORD = "INLINE_PASSWORD",
  INLINE_EMAIL_CODE = "INLINE_EMAIL_CODE",
}

export enum EAuthenticationErrorCodes {
  // Global
  INSTANCE_NOT_CONFIGURED = "5000",
  INVALID_EMAIL = "5005",
  EMAIL_REQUIRED = "5010",
  SIGNUP_DISABLED = "5015",
  MAGIC_LINK_LOGIN_DISABLED = "5016",
  BOT_USER_LOGIN_FORBIDDEN = "5017",
  PASSWORD_LOGIN_DISABLED = "5018",
  USER_ACCOUNT_DEACTIVATED = "5019",
  // Password strength
  INVALID_PASSWORD = "5020",
  PASSWORD_TOO_WEAK = "5021",
  SMTP_NOT_CONFIGURED = "5025",
  // Sign Up
  USER_ALREADY_EXIST = "5030",
  AUTHENTICATION_FAILED_SIGN_UP = "5035",
  REQUIRED_EMAIL_PASSWORD_SIGN_UP = "5040",
  INVALID_EMAIL_SIGN_UP = "5045",
  INVALID_EMAIL_MAGIC_SIGN_UP = "5050",
  MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED = "5055",
  // Sign In
  USER_DOES_NOT_EXIST = "5060",
  AUTHENTICATION_FAILED_SIGN_IN = "5065",
  REQUIRED_EMAIL_PASSWORD_SIGN_IN = "5070",
  INVALID_EMAIL_SIGN_IN = "5075",
  INVALID_EMAIL_MAGIC_SIGN_IN = "5080",
  MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED = "5085",
  // Both Sign in and Sign up for magic
  INVALID_MAGIC_CODE_SIGN_IN = "5090",
  INVALID_MAGIC_CODE_SIGN_UP = "5092",
  EXPIRED_MAGIC_CODE_SIGN_IN = "5095",
  EXPIRED_MAGIC_CODE_SIGN_UP = "5097",
  EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN = "5100",
  EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP = "5102",
  // Oauth
  OAUTH_NOT_CONFIGURED = "5104",
  GOOGLE_NOT_CONFIGURED = "5105",
  GITHUB_NOT_CONFIGURED = "5110",
  GITLAB_NOT_CONFIGURED = "5111",
  GOOGLE_OAUTH_PROVIDER_ERROR = "5115",
  GITHUB_OAUTH_PROVIDER_ERROR = "5120",
  GITLAB_OAUTH_PROVIDER_ERROR = "5121",
  // Reset Password
  INVALID_PASSWORD_TOKEN = "5125",
  EXPIRED_PASSWORD_TOKEN = "5130",
  // Change password
  INCORRECT_OLD_PASSWORD = "5135",
  MISSING_PASSWORD = "5138",
  INVALID_NEW_PASSWORD = "5140",
  // set password
  PASSWORD_ALREADY_SET = "5145",
  // Admin
  ADMIN_ALREADY_EXIST = "5150",
  REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME = "5155",
  INVALID_ADMIN_EMAIL = "5160",
  INVALID_ADMIN_PASSWORD = "5165",
  REQUIRED_ADMIN_EMAIL_PASSWORD = "5170",
  ADMIN_AUTHENTICATION_FAILED = "5175",
  ADMIN_USER_ALREADY_EXIST = "5180",
  ADMIN_USER_DOES_NOT_EXIST = "5185",
  ADMIN_USER_DEACTIVATED = "5190",
  // Rate limit
  RATE_LIMIT_EXCEEDED = "5900",
  // Fork-local, client-side only (APLANE-36). It exists so that a request which produced no
  // response at all can travel through authErrorHandler like every other failure, instead of
  // needing a parallel code path in the form.
  //
  // NOT a number, deliberately. The whole 5xxx space belongs to the server's
  // AUTHENTICATION_ERROR_CODES (apps/api/plane/authentication/adapter/error.py), and the first
  // draft of this used 5999 — which is already taken there by "AUTHENTICATION_FAILED", the generic
  // Unknown catch-all. Since auth-root.tsx reads `error_code` out of the URL and feeds it to this
  // same handler, that would have printed "Could not reach the server" for a real authentication
  // failure the day anything raised it. A non-numeric value cannot collide with that space at all.
  REQUEST_FAILED = "CLIENT_REQUEST_FAILED",
}

export type TAuthErrorInfo = {
  type: EErrorAlertType;
  code: EAuthenticationErrorCodes;
  title: string;
  message: ReactNode;
};

// TODO: move all error messages to translation files
const errorCodeMessages: {
  [key in EAuthenticationErrorCodes]: { title: string; message: (email?: string) => ReactNode };
} = {
  // fork-local (APLANE-36)
  [EAuthenticationErrorCodes.REQUEST_FAILED]: {
    title: `Could not reach the server`,
    message: () => `We could not reach the server. Check your connection and try again.`,
  },
  // global
  [EAuthenticationErrorCodes.INSTANCE_NOT_CONFIGURED]: {
    title: `Instance not configured`,
    message: () => `Instance not configured. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.INVALID_EMAIL]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  [EAuthenticationErrorCodes.EMAIL_REQUIRED]: {
    title: `Email required`,
    message: () => `Email required. Please try again.`,
  },
  [EAuthenticationErrorCodes.SIGNUP_DISABLED]: {
    title: `Sign up disabled`,
    message: () => `Sign up disabled. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.MAGIC_LINK_LOGIN_DISABLED]: {
    title: `Magic link login disabled`,
    message: () => `Magic link login disabled. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.PASSWORD_LOGIN_DISABLED]: {
    title: `Password login disabled`,
    message: () => `Password login disabled. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.USER_ACCOUNT_DEACTIVATED]: {
    title: `User account deactivated`,
    message: () => `User account deactivated. Please contact ${SUPPORT_EMAIL ? SUPPORT_EMAIL : "administrator"}.`,
  },
  [EAuthenticationErrorCodes.BOT_USER_LOGIN_FORBIDDEN]: {
    title: `Sign in not allowed`,
    message: () => `This account cannot be used to sign in. Please use a personal account.`,
  },
  [EAuthenticationErrorCodes.INVALID_PASSWORD]: {
    title: `Invalid password`,
    message: () => `Invalid password. Please try again.`,
  },
  [EAuthenticationErrorCodes.PASSWORD_TOO_WEAK]: {
    title: `Password too weak`,
    message: () => `Please use a stronger password.`,
  },
  [EAuthenticationErrorCodes.SMTP_NOT_CONFIGURED]: {
    title: `SMTP not configured`,
    message: () => `SMTP not configured. Please contact your administrator.`,
  },

  // sign up
  [EAuthenticationErrorCodes.USER_ALREADY_EXIST]: {
    title: `User already exists`,
    message: (email = undefined) => (
      <div>
        Your account is already registered.&nbsp;
        <Link
          className="font-medium underline underline-offset-4 transition-all hover:font-bold"
          href={`/sign-in${email ? `?email=${encodeURIComponent(email)}` : ``}`}
        >
          Sign In
        </Link>
        &nbsp;now.
      </div>
    ),
  },
  [EAuthenticationErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_UP]: {
    title: `Email and password required`,
    message: () => `Email and password required. Please try again.`,
  },
  [EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_UP]: {
    title: `Authentication failed`,
    message: () => `Authentication failed. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_EMAIL_SIGN_UP]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  [EAuthenticationErrorCodes.MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED]: {
    title: `Email and code required`,
    message: () => `Email and code required. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },

  [EAuthenticationErrorCodes.USER_DOES_NOT_EXIST]: {
    title: `User does not exist`,
    message: (email = undefined) => (
      <div>
        No account found.&nbsp;
        <Link
          className="font-medium underline underline-offset-4 transition-all hover:font-bold"
          href={`/${email ? `?email=${encodeURIComponent(email)}` : ``}`}
        >
          Create one
        </Link>
        &nbsp;to get started.
      </div>
    ),
  },
  [EAuthenticationErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_IN]: {
    title: `Email and password required`,
    message: () => `Email and password required. Please try again.`,
  },
  [EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN]: {
    title: `Authentication failed`,
    message: () => `Authentication failed. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_EMAIL_SIGN_IN]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },
  [EAuthenticationErrorCodes.MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED]: {
    title: `Email and code required`,
    message: () => `Email and code required. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN]: {
    title: `Invalid email`,
    message: () => `Invalid email. Please try again.`,
  },

  // Both Sign in and Sign up
  [EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_IN]: {
    title: `Authentication failed`,
    message: () => `Invalid magic code. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_UP]: {
    title: `Authentication failed`,
    message: () => `Invalid magic code. Please try again.`,
  },
  [EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  [EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  [EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },
  [EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP]: {
    title: `Expired magic code`,
    message: () => `Expired magic code. Please try again.`,
  },

  // Oauth
  [EAuthenticationErrorCodes.OAUTH_NOT_CONFIGURED]: {
    title: `OAuth not configured`,
    message: () => `OAuth not configured. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.GOOGLE_NOT_CONFIGURED]: {
    title: `Google not configured`,
    message: () => `Google not configured. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.GITHUB_NOT_CONFIGURED]: {
    title: `GitHub not configured`,
    message: () => `GitHub not configured. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.GITLAB_NOT_CONFIGURED]: {
    title: `GitLab not configured`,
    message: () => `GitLab not configured. Please contact your administrator.`,
  },
  [EAuthenticationErrorCodes.GOOGLE_OAUTH_PROVIDER_ERROR]: {
    title: `Google OAuth provider error`,
    message: () => `Google OAuth provider error. Please try again.`,
  },
  [EAuthenticationErrorCodes.GITHUB_OAUTH_PROVIDER_ERROR]: {
    title: `GitHub OAuth provider error`,
    message: () => `GitHub OAuth provider error. Please try again.`,
  },
  [EAuthenticationErrorCodes.GITLAB_OAUTH_PROVIDER_ERROR]: {
    title: `GitLab OAuth provider error`,
    message: () => `GitLab OAuth provider error. Please try again.`,
  },

  // Reset Password
  [EAuthenticationErrorCodes.INVALID_PASSWORD_TOKEN]: {
    title: `Invalid password token`,
    message: () => `Invalid password token.`,
  },
  [EAuthenticationErrorCodes.EXPIRED_PASSWORD_TOKEN]: {
    title: `Expired password token`,
    message: () => `Expired password token. Please try again.`,
  },

  // Change password
  [EAuthenticationErrorCodes.MISSING_PASSWORD]: {
    title: `Password required`,
    message: () => `Password required. Please try again.`,
  },
  [EAuthenticationErrorCodes.INCORRECT_OLD_PASSWORD]: {
    title: `Incorrect old password`,
    message: () => `Incorrect old password. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_NEW_PASSWORD]: {
    title: `Invalid new password`,
    message: () => `Invalid new password. Please try again.`,
  },

  // set password
  [EAuthenticationErrorCodes.PASSWORD_ALREADY_SET]: {
    title: `Password already set`,
    message: () => `Password already set. Please try again.`,
  },

  // admin
  [EAuthenticationErrorCodes.ADMIN_ALREADY_EXIST]: {
    title: `Admin already exists`,
    message: () => `Admin already exists. Please try again.`,
  },
  [EAuthenticationErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME]: {
    title: `Email, password and first name required`,
    message: () => `Email, password and first name required. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_ADMIN_EMAIL]: {
    title: `Invalid admin email`,
    message: () => `Invalid admin email. Please try again.`,
  },
  [EAuthenticationErrorCodes.INVALID_ADMIN_PASSWORD]: {
    title: `Invalid admin password`,
    message: () => `Invalid admin password. Please try again.`,
  },
  [EAuthenticationErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD]: {
    title: `Email and password required`,
    message: () => `Email and password required. Please try again.`,
  },
  [EAuthenticationErrorCodes.ADMIN_AUTHENTICATION_FAILED]: {
    title: `Authentication failed`,
    message: () => `Authentication failed. Please try again.`,
  },
  [EAuthenticationErrorCodes.ADMIN_USER_ALREADY_EXIST]: {
    title: `Admin user already exists`,
    message: () => (
      <div>
        Admin user already exists.&nbsp;
        <Link className="font-medium underline underline-offset-4 transition-all hover:font-bold" href={`/admin`}>
          Sign In
        </Link>
        &nbsp;now.
      </div>
    ),
  },
  [EAuthenticationErrorCodes.ADMIN_USER_DOES_NOT_EXIST]: {
    title: `Admin user does not exist`,
    message: () => (
      <div>
        Admin user does not exist.&nbsp;
        <Link className="font-medium underline underline-offset-4 transition-all hover:font-bold" href={`/admin`}>
          Sign In
        </Link>
        &nbsp;now.
      </div>
    ),
  },
  [EAuthenticationErrorCodes.ADMIN_USER_DEACTIVATED]: {
    title: `Admin user deactivated`,
    message: () => <div>Your account is deactivated</div>,
  },
  [EAuthenticationErrorCodes.RATE_LIMIT_EXCEEDED]: {
    title: "",
    message: () => `Rate limit exceeded. Please try again later.`,
  },
};

export const authErrorHandler = (errorCode: EAuthenticationErrorCodes, email?: string): TAuthErrorInfo | undefined => {
  const bannerAlertErrorCodes = [
    EAuthenticationErrorCodes.INSTANCE_NOT_CONFIGURED,
    EAuthenticationErrorCodes.INVALID_EMAIL,
    EAuthenticationErrorCodes.EMAIL_REQUIRED,
    EAuthenticationErrorCodes.SIGNUP_DISABLED,
    EAuthenticationErrorCodes.MAGIC_LINK_LOGIN_DISABLED,
    EAuthenticationErrorCodes.PASSWORD_LOGIN_DISABLED,
    EAuthenticationErrorCodes.BOT_USER_LOGIN_FORBIDDEN,
    EAuthenticationErrorCodes.USER_ACCOUNT_DEACTIVATED,
    EAuthenticationErrorCodes.INVALID_PASSWORD,
    EAuthenticationErrorCodes.SMTP_NOT_CONFIGURED,
    EAuthenticationErrorCodes.USER_ALREADY_EXIST,
    EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_UP,
    EAuthenticationErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_UP,
    EAuthenticationErrorCodes.INVALID_EMAIL_SIGN_UP,
    EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_UP,
    EAuthenticationErrorCodes.MAGIC_SIGN_UP_EMAIL_CODE_REQUIRED,
    EAuthenticationErrorCodes.USER_DOES_NOT_EXIST,
    EAuthenticationErrorCodes.AUTHENTICATION_FAILED_SIGN_IN,
    EAuthenticationErrorCodes.REQUIRED_EMAIL_PASSWORD_SIGN_IN,
    EAuthenticationErrorCodes.INVALID_EMAIL_SIGN_IN,
    EAuthenticationErrorCodes.INVALID_EMAIL_MAGIC_SIGN_IN,
    EAuthenticationErrorCodes.MAGIC_SIGN_IN_EMAIL_CODE_REQUIRED,
    EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_IN,
    EAuthenticationErrorCodes.INVALID_MAGIC_CODE_SIGN_UP,
    EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_IN,
    EAuthenticationErrorCodes.EXPIRED_MAGIC_CODE_SIGN_UP,
    EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_IN,
    EAuthenticationErrorCodes.EMAIL_CODE_ATTEMPT_EXHAUSTED_SIGN_UP,
    EAuthenticationErrorCodes.OAUTH_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GOOGLE_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GITHUB_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GITLAB_NOT_CONFIGURED,
    EAuthenticationErrorCodes.GOOGLE_OAUTH_PROVIDER_ERROR,
    EAuthenticationErrorCodes.GITHUB_OAUTH_PROVIDER_ERROR,
    EAuthenticationErrorCodes.GITLAB_OAUTH_PROVIDER_ERROR,
    EAuthenticationErrorCodes.INVALID_PASSWORD_TOKEN,
    EAuthenticationErrorCodes.EXPIRED_PASSWORD_TOKEN,
    EAuthenticationErrorCodes.INCORRECT_OLD_PASSWORD,
    EAuthenticationErrorCodes.MISSING_PASSWORD,
    EAuthenticationErrorCodes.INVALID_NEW_PASSWORD,
    EAuthenticationErrorCodes.PASSWORD_ALREADY_SET,
    EAuthenticationErrorCodes.ADMIN_ALREADY_EXIST,
    EAuthenticationErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD_FIRST_NAME,
    EAuthenticationErrorCodes.INVALID_ADMIN_EMAIL,
    EAuthenticationErrorCodes.INVALID_ADMIN_PASSWORD,
    EAuthenticationErrorCodes.REQUIRED_ADMIN_EMAIL_PASSWORD,
    EAuthenticationErrorCodes.ADMIN_AUTHENTICATION_FAILED,
    EAuthenticationErrorCodes.ADMIN_USER_ALREADY_EXIST,
    EAuthenticationErrorCodes.ADMIN_USER_DOES_NOT_EXIST,
    EAuthenticationErrorCodes.ADMIN_USER_DEACTIVATED,
    EAuthenticationErrorCodes.RATE_LIMIT_EXCEEDED,
    EAuthenticationErrorCodes.PASSWORD_TOO_WEAK,
    EAuthenticationErrorCodes.REQUEST_FAILED,
  ];

  if (bannerAlertErrorCodes.includes(errorCode))
    return {
      type: EErrorAlertType.BANNER_ALERT,
      code: errorCode,
      title: errorCodeMessages[errorCode]?.title || "Error",
      message: errorCodeMessages[errorCode]?.message(email) || "Something went wrong. Please try again.",
    };

  return undefined;
};

/** Whatever an auth service rejected with: its error body, or the APLANE-36 synthetic payload. */
type TAuthFailure = { error_code?: string | number; isRequestFailure?: boolean };

/**
 * Pick the banner for a failed auth call (APLANE-36).
 *
 * `authErrorHandler` above maps a SERVER error code, and a request that never reached the server
 * has none: `error_code` is undefined, the handler returns undefined, and the
 * `if (errorhandler?.type)` guard at the call sites then skips `setErrorInfo` entirely. The result
 * was the worst of the three screens in this ticket — Continue did nothing at all, no banner, no
 * inline message, no console error, for a user who cannot sign in and has no idea why.
 *
 * It lives here rather than in form-root so that the decision is next to the mapping it extends,
 * and so a test can reach it without mounting the form (which would drag in the instance store,
 * react-hook-form and the email step to pin one line).
 *
 * NOTE the form that calls this only renders when email or magic-link login is enabled, and both
 * are OFF in our prod instance (asserted every deploy by L3-02-served-auth-flags:
 * `is_email_password_enabled` is False there, True on dev). So in prod this path is unreachable
 * today; it is for dev, and for the day prod turns password login back on. The reachable half of
 * APLANE-36 is the shell and the archived work item.
 */
export const authBannerFor = (error: TAuthFailure | undefined, userEmail?: string): TAuthErrorInfo | undefined =>
  asRequestFailure(error)
    ? authErrorHandler(EAuthenticationErrorCodes.REQUEST_FAILED)
    : authErrorHandler(error?.error_code?.toString() as EAuthenticationErrorCodes, userEmail);

export const passwordErrors = [
  EAuthenticationErrorCodes.PASSWORD_TOO_WEAK,
  EAuthenticationErrorCodes.INVALID_NEW_PASSWORD,
];
