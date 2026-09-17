/** Logs every QA user in once (real password sign-in) and stores the session per user. */
import { test as setup, expect } from "@playwright/test";
import { authFile, QA_USERS } from "./helpers";

for (const user of QA_USERS) {
  setup(`sign in as ${user}`, async ({ request, baseURL }) => {
    const { csrf_token } = await (await request.get("/auth/get-csrf-token/")).json();
    const res = await request.post("/auth/sign-in/", {
      form: {
        csrfmiddlewaretoken: csrf_token,
        email: `${user}@plane-tests.invalid`,
        password: process.env.PT_QA_PASSWORD ?? "",
      },
      headers: { Referer: `${baseURL}/` },
      maxRedirects: 0,
    });
    expect(res.status(), "sign-in redirects").toBe(302);
    expect(res.headers()["location"] ?? "", "no auth error").not.toContain("error_code");
    await request.storageState({ path: authFile(user) });
  });
}
