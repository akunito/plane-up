// Who can see a project's lists, said the same way by the shopping app and the main app's project page.
// A list is exactly as private as its project (brief: Privacy): public means any workspace member may join,
// and a workspace admin may join a secret one.

import type { VisibleProject } from "./client";

export type Audience =
  | { kind: "only_you" }
  | { kind: "people"; names: string[] }
  | { kind: "public"; names: string[] }
  | { kind: "admins"; names: string[]; admins: number };

export function audience(project: VisibleProject, meId: string): Audience {
  const names = project.members.filter((m) => m.id !== meId).map((m) => m.display_name);
  if (project.network !== 0) return { kind: "public", names };
  if (project.admins_outside > 0) return { kind: "admins", names, admins: project.admins_outside };
  return names.length === 0 ? { kind: "only_you" } : { kind: "people", names };
}
