# Plane — Mobile & UX Design Brief (for Claude Design)

## What this is
Plane is a self-hosted project-management app (issues, projects, cycles, docs — a Linear/Jira
alternative). We run the open-source web app and use it on phones as an installed PWA. The web UI
is built desktop-first and breaks on mobile, plus a few interactions are weak. We are **patching the
existing app**, so designs must **match Plane's current visual language** — don't invent a new design
system.

### Respect the existing look & feel
- Dark theme primary (light theme also exists). Neutral grays, subtle 1px borders, `rounded-md`
  cards, compact spacing, Inter-style sans font.
- Accent colors are semantic: each **state** has a color/icon (Backlog, Todo, In Progress, In Review,
  Done, Cancelled) and each **priority** has an icon (Urgent/High/Medium/Low/None).
- Keep components feeling native to Plane (like Linear): quiet, dense, keyboard/touch-friendly.
- Target viewport: **portrait phone, 360–430px wide**. Must also still look right on tablet/desktop
  (responsive, not a separate skin).

### Vocabulary (use these names)
- **Work item** = an issue/task. **Peek** = the issue detail panel. **Layouts** = the view modes:
  List, Board (kanban), Calendar, Spreadsheet (table), Gantt/Timeline.
- **Display options** = the panel holding *Group by*, *Sort/Order by*, *Layout*, sub-grouping.
- **Views** = saved filtered views. **Favorites** = pinned items in the left sidebar.

---

## Problem 1 — The app is not usable on a phone (top priority)
**Current behavior:** The layout is desktop-fixed in key places. The left sidebar, detail panels, and
data grids assume a wide screen, so on a phone things overflow, overlap, or don't open. Specifically
broken today:
- The **left navigation sidebar** is a fixed desktop column; on mobile it must become an off-canvas
  drawer (it half-works via JS but isn't designed for touch).
- Opening a **Views** page often "does nothing" on mobile — because it renders whatever **saved
  layout** it has (often Spreadsheet or Gantt), and those layouts choke on a narrow screen.
- Modals and side panels use fixed pixel widths that exceed the screen.

**What to design:**
- A coherent **mobile app shell**: top bar (workspace/project context + search + create `+`),
  an off-canvas **navigation drawer**, and ideally a **bottom tab bar** for the most-used
  destinations (e.g. Home/Your Work, Projects, Notifications, Search). Decide and show it.
- Define the responsive rule: **on phones, default any view to the List layout** (the only layout
  that's genuinely good on a phone), with an easy way to switch layout if the user wants.
- Mobile-friendly **modals** (full-screen sheets / bottom sheets instead of fixed-width dialogs).

---

## Problem 2 — Work item detail is a cramped side panel on mobile
**Current behavior:** Tapping a work item opens a **"peek" panel** that slides in from the right. Inside
it, the properties column is a **hard-coded 400px** width, which overflows a ~375px phone — so detail
view is broken on mobile.

**What to design (this is the most important screen):** a **full-screen mobile work-item detail**:
- Title, description (rich text), and a clean, **stacked properties section** (no fixed-width side
  column) showing & letting the user edit: **State, Priority, Assignees, Start/Due dates, Labels,
  Cycle, Module, Estimate, Parent**.
- Each property should be **tap-to-edit inline** (open a bottom sheet picker for state/priority/
  assignee/date/labels). This is exactly the kind of fast inline editing that should feel effortless
  on mobile.
- Activity/comments section below, with a sticky comment input at the bottom.
- Sub-items and links/attachments sections.

---

## Problem 3 — Board (Kanban) is awkward on phones, and cards should be rich
**Current behavior:** Board columns are **fixed 350px wide** with horizontal scrolling. On a phone you
see one-and-a-bit columns and must scroll sideways. Cards themselves are fine on desktop (they show
inline state/priority/dates/assignee/labels) — preserve that richness on mobile.

**What to design:**
- A **mobile board** pattern: full-width column that fills the screen, with a **column switcher**
  (swipe between columns or a sticky segmented header showing column name + count, e.g.
  "In Progress · 12"). Show how the user moves a card to another status on a phone (e.g. a
  "Move to…" action in the card's menu, since drag-across-columns is hard on mobile).
- A **rich work-item card** for mobile that keeps Plane's inline chips: state, priority icon,
  due date, assignee avatar, labels, sub-item count — tappable to edit where sensible, tap-on-card
  to open the full detail (Problem 2).

---

## Problem 4 — Spreadsheet (table) layout on mobile
**Current behavior:** The table has a **min-width ~360px name column** plus many fixed columns and a
sticky header — it becomes a horizontal-scroll mess on a phone.

**What to design:** a **mobile fallback** for the spreadsheet — collapse each row into a **compact card
list** (title + the few most relevant columns as chips), rather than a wide scrolling table. (Gantt/
Timeline can stay desktop-only with a friendly "best viewed on a larger screen" message — design that
empty/notice state too.)

---

## Problem 5 — Multi-column sorting (feature gap, desktop + mobile)
**Current behavior:** In **Display options → Sort/Order by**, you can only pick **one** field
(single-select radio), e.g. sort by Priority *or* Due date — not both.

**What to design:** a **multi-criteria sort UI**: an ordered list of sort rules (e.g. ① Priority ↓,
② Due date ↑, ③ Created ↓), where the user can **add a field, set each direction, reorder them
(drag), and remove**. Show it both as a desktop popover and as a mobile bottom sheet. Keep it simple
and obvious — it should read like "sort by this, then by that."

---

## Problem 6 — Kanban (Board) layout missing on cross-project views
**Current behavior:** Inside a single project you can switch to the Board layout. But the **workspace-
level / cross-project views** ("Your Work", "All Issues", workspace Views) only offer **List and
Spreadsheet** — no Board. Users want a kanban across projects.

**What to design:** the **layout switcher for global/cross-project views including a Board option**.
Because states differ per project, design the board to **group by a global dimension** — primarily
**State group** (Backlog / Unstarted / Started / Completed / Cancelled), with **Priority** and
**Project** as alternative groupings. Show the group-by selector and what a cross-project board card
looks like (it should show which **project** each card belongs to, since they're mixed).

---

## Problem 7 — Sidebar favorites / pinning
**Current behavior:** You can "star"/pin projects, views, cycles, modules, and pages into a
**Favorites** section in the left sidebar, and drag to reorder or group them into folders — but the
**reorder/grouping doesn't stick reliably** (a known bug we'll fix in code). From a design angle the
interaction is also unclear.

**What to design:** a clean **Favorites** section in the navigation drawer: how a pinned item looks,
how **folders/groups** look, the **drag-to-reorder** affordance (and a non-drag fallback for touch,
e.g. a "move up/down" or long-press menu), and the empty state. Make the pin/unpin action obvious
from each item's context menu.

---

## Deliverables requested
Mobile (portrait) designs for, in priority order:
1. App shell — nav drawer + (proposed) bottom tab bar + top bar with search/create
2. **Work item detail (full-screen)** with stacked, tap-to-edit properties + bottom-sheet pickers
3. Work items **List** layout (the mobile default) + the **rich card**
4. **Board** layout mobile pattern (column switcher + move-card action)
5. **Display options** bottom sheet: Layout switch, Group by, **multi-criteria Sort**
6. Spreadsheet→card fallback; Gantt "larger screen" notice
7. Cross-project **Board** (group-by State group/Priority/Project) with project-tagged cards
8. **Favorites** in the drawer (pin, folders, reorder, empty state)

Please keep everything consistent with Plane's existing dark, compact, Linear-like aesthetic so it can
be implemented directly as responsive changes to the current components.
