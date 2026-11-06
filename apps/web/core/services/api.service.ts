/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AxiosInstance, AxiosRequestConfig } from "axios";
import { create, isCancel } from "axios";

/**
 * Make sure a rejected request always carries a `response.data` (APLANE-36).
 *
 * Census of the throw sites, 2026-11-06: 376 `throw error?.response?.data`, 21
 * `throw err?.response?.data`, 1 `throw error.response.data` (guarded by its own `if`), and 79
 * `throw error?.response`. When the server never answered — connection dropped, server
 * restarting, DNS, a proxy closing the socket — axios rejects with no `response` at all, so all of
 * those threw `undefined`. A consumer then reaches its `catch` with nothing to test: hence a
 * sign-in button that does nothing, a blank page on a work item, and a skeleton loader that never
 * resolves (APLANE-35).
 *
 * Fixing it here rather than at those ~470 sites is the whole point: a service keeps throwing
 * `error.response.data` (or `error.response`) and now that value is always truthy. Note what that
 * means precisely for the 79 `throw error?.response` sites: they used to throw `undefined` and now
 * throw the synthetic response below. Their consumers read `err?.data?.error ?? t(…)` and
 * `err.status === 429 | 400`, none of which matches a `status` of 0.
 *
 * **The payload deliberately carries NO prose** — no `error`, `message` or `detail` key. 30 call
 * sites read `error?.error ?? t("…translated…")` (35 read it at all), so filling those fields
 * would replace every one of those translated messages with an English string invented in the
 * service layer. Machine-readable flags only; the UI keeps its own wording.
 *
 * This is NECESSARY BUT NOT SUFFICIENT for the screens in APLANE-36: each of them ignores the
 * error entirely (the sign-in form keys on `error_code`, the archived work item on `!issue`, the
 * shell on `currentUser?.id`), so they need their own branch on `isRequestFailure`. What this
 * interceptor removes is the reason those branches could not be written.
 */
export type TRequestFailurePayload = {
  /** The HTTP status, or 0 when there was no response at all. */
  status: number;
  /** Always true: this payload only ever exists because the request produced no usable body. */
  isRequestFailure: true;
  isTimeout: boolean;
  /** axios' own code (ERR_NETWORK, ECONNABORTED, …). For logs; nothing renders it. */
  axiosCode?: string;
};

const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

export const requestFailurePayload = (error: any): TRequestFailurePayload => ({
  status: typeof error?.response?.status === "number" ? error.response.status : 0,
  isRequestFailure: true,
  isTimeout: TIMEOUT_CODES.has(error?.code),
  axiosCode: error?.code,
});

export const ensureErrorPayload = (error: any): any => {
  // A cancelled request is not a failure anybody should see. Left exactly as it was, so a consumer
  // that navigates away mid-request keeps getting today's inert rejection instead of a new error
  // state (and axios' own isCancel checks keep working on an untouched object). Asking axios
  // rather than matching its code strings: the installed 1.18.1 and the lockfile's 1.20.0 are not
  // the same build, and seven issue stores plus both FileUploadServices do cancel requests.
  if (isCancel(error)) return error;

  const body = error?.response?.data;
  // An empty string is what a proxy's bodyless 502 leaves here, and it is falsy — same bug.
  if (body !== undefined && body !== null && body !== "") return error;

  const payload = requestFailurePayload(error);

  if (error?.response) {
    error.response.data = payload;
    return error;
  }
  if (error && typeof error === "object") {
    // `status: 0` on purpose: no status check in the app matches it, so nothing starts branching
    // on a response that never happened. Only `error.response.data` becomes reachable.
    error.response = { status: 0, statusText: "", headers: {}, config: error?.config, data: payload };
    return error;
  }
  // axios always rejects with an object, but a mocked service or a non-axios throw might not.
  return { response: { status: 0, statusText: "", headers: {}, data: payload } };
};

/**
 * Read the failure payload back out of whatever a service threw (APLANE-36).
 *
 * Three conventions in this repo put it in three different places, and a consumer that reaches
 * into the wrong one gets `undefined` and silently keeps the old do-nothing behaviour — which is
 * the very bug this ticket is about, one level up. Verified call site by call site:
 *   - `throw error?.response?.data` (376 sites; auth.service.emailCheck) -> the payload itself
 *   - `throw error?.response`       (79 sites; user.service.currentUser)  -> `.data`
 *   - `throw error`                 (instance.service.getInstanceInfo)    -> `.response.data`
 * Returns undefined for a real API error body, for a cancellation and for anything else. Strictly
 * it tests a field name, so what makes it safe is that no Plane endpoint returns `isRequestFailure`:
 * DRF bodies are snake_case (`detail`, `error`, `error_code`, field-error dicts), and a cancellation
 * is returned untouched by ensureErrorPayload above and carries the flag nowhere.
 */
export const asRequestFailure = (error: any): TRequestFailurePayload | undefined => {
  for (const candidate of [error, error?.data, error?.response?.data]) {
    if (candidate?.isRequestFailure === true) return candidate as TRequestFailurePayload;
  }
  return undefined;
};

export abstract class APIService {
  protected baseURL: string;
  private axiosInstance: AxiosInstance;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
    this.axiosInstance = create({
      baseURL,
      withCredentials: true,
    });

    this.setupInterceptors();
  }

  private setupInterceptors() {
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response && error.response.status === 401) {
          const currentPath = window.location.pathname;
          window.location.replace(`/${currentPath ? `?next_path=${currentPath}` : ``}`);
        }
        // After the 401 branch on purpose: it reads the real response, and the payload below is
        // never a 401, so the order cannot change who gets redirected.
        return Promise.reject(ensureErrorPayload(error));
      }
    );
  }

  get(url: string, params = {}, config: AxiosRequestConfig = {}) {
    return this.axiosInstance.get(url, {
      ...params,
      ...config,
    });
  }

  post(url: string, data = {}, config: AxiosRequestConfig = {}) {
    return this.axiosInstance.post(url, data, config);
  }

  put(url: string, data = {}, config: AxiosRequestConfig = {}) {
    return this.axiosInstance.put(url, data, config);
  }

  patch(url: string, data = {}, config: AxiosRequestConfig = {}) {
    return this.axiosInstance.patch(url, data, config);
  }

  delete(url: string, data?: any, config: AxiosRequestConfig = {}) {
    return this.axiosInstance.delete(url, { data, ...config });
  }

  request(config = {}) {
    return this.axiosInstance(config);
  }
}
