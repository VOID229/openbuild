# OpenChat — Frontend Implementation SPEC (upstream reference)

> This document preserves the original openchat UI specification, not OpenBuild's product scope. **openchat** is the hosted chatting app at https://openchat.shade-io.com, with accounts and Convex cloud syncing. **OpenBuild** is its self-hosted coding-focused fork, powered by Pi, accessed over localhost, LAN, or Tailscale at the user's choice. OpenBuild offers no cloud accounts or cloud syncing. See `README.md` for the current product and setup.

> Source of truth: Excalidraw wireframe (parsed). Implement layout **1:1** with the diagram.
> Do **not** invent features that are not in the diagram. Ambiguities are flagged explicitly.
>
> **Legend for this SPEC**
> - **UI copy** = strings that appear in the product UI exactly as written (including `#` markdown-style headings with underlines).
> - **Agent note** = diagram annotations (smaller callouts / arrow-linked comments). These are **implementation instructions**, never shown as UI copy.

---

## 0. Product overview

**OpenChat** is a chat client with:

1. A **home / empty-chat** screen (centered prompt + composer).
2. An **active chat** screen (messages + bottom composer + contextual “think harder / think faster” controls).
3. A **Settings** modal (depth-of-field blur backdrop) with four sections: **Profile**, **General**, **API Keys**, **Appearance**.

Primary chrome on both chat screens: **left sidebar** + **main pane**.

---

## 1. Global UX polish (mandatory)

Beyond layout fidelity, the UI must feel **premium, clean, and refined**:

| Requirement | Detail |
|---|---|
| **Clickables** | Every interactive control uses `cursor: pointer` |
| **Hover** | Subtle gray hover states on buttons, nav items, chips, list rows, icon buttons (e.g. `background: rgba(0,0,0,0.04)` light / `rgba(255,255,255,0.06)` dark) |
| **Transitions** | Short, refined transitions (~150–250ms, ease-out) on hover, focus, open/close, toggle |
| **Animations** | Smooth open/close for modal, dropdowns, sidebar collapse; no janky pops |
| **Modal backdrop** | **Depth-of-field / blur** behind Settings (and any similar popups): frosted/blurred page content + dim overlay |
| **Focus** | Visible focus rings for keyboard users; inputs get clean focus borders |
| **Depth** | Soft shadows on modal card, elevated buttons, and popovers — not heavy/material-chunky |
| **Typography** | Tight, readable hierarchy; section `#` headings render with a nice underline (see §5) |
| **Icons** | **Exact Lucide icons only** — match the Lucide glyphs used in the Excalidraw (no substitutes, no custom SVGs that only “look similar”). Use the Lucide React/SVG set 1:1 for every icon in the UI. |

---



### 1.1 Exact Lucide icons (mandatory)

The wireframe was drawn with **Lucide** icons. Implementation **must** use the **exact same Lucide icon names/glyphs** — not approximations or alternate icon packs.

Known mappings from the diagram (use these Lucide names; expand if more appear in the canvas):

| UI control | Lucide icon |
|---|---|
| Sidebar panel toggle | `panel-left` (or the exact Lucide used in the file) |
| Menu / hamburger | `menu` |
| New chat | `square-pen` / `pen-square` (match Excalidraw) |
| Search | `search` |
| Settings avatar affordance | Lucide avatar/user as drawn |
| Attach (`+`) | `plus` |
| Mic / dictation | `mic` |
| Send | `arrow-up` (or exact send glyph in file) |
| Think harder | `lightbulb` |
| Think faster | `zap` |
| Profile edit photo | `pencil` |
| Model picker filter | `list-filter` |

If an icon in Excalidraw is Lucide, copy that icon name into code. Do not invent a different Lucide name “because it’s close.”

## 2. App shell layout (both chat screens)

### 2.1 Outer window

- Rounded rectangle app frame (~16:9-ish chat window).
- Two columns:
  - **Sidebar** ≈ **18–19%** of window width (diagram: ~302 / 1628).
  - **Main pane** = remaining width.

### 2.2 Sidebar (left)

Top → bottom:

1. **Brand row**
   - Left: **sidebar-panel icon** button (narrow rect with vertical divider — toggle sidebar).
   - **“OpenChat”** wordmark (prominent).
   - Right of wordmark: **hamburger / menu** icon (three horizontal lines) — sidebar/menu control.
2. **“New chat”** button
   - Leading **compose / new** icon in a small rounded square.
   - Label UI copy: `New chat`
   - Full-width-ish pill/button in sidebar.
3. **Search**
   - Magnifying-glass icon + placeholder UI copy: `Search your chats...`
   - Appears as a search field / search affordance under New chat.
4. **Chat history list region**
   - Diagram shows **no sample history rows** — implement an empty scrollable list area (ready for chat titles later). Do not invent fake chats unless wiring to real data.
5. **Bottom: Settings**
   - Circular **avatar / user** icon + label UI copy: `Settings`
   - Click opens Settings modal (§5).

**Divider:** thin horizontal rule under the search block separating header controls from the history list region.

### 2.3 Main pane — shared composer chrome

Composer is a **large rounded rectangle** input card. Controls (left → right as drawn):

| Control | Placement | UI copy / behavior |
|---|---|---|
| Text area | Main of card | Home empty state has no placeholder inside the box (prompt is outside). Active chat: standard message input. |
| **Attach (`+`)** | **Bottom-left** inside the composer card | Lucide **`plus`** icon (stroke). Opens attach / file-pick affordance. **This is the attach control** — not a circular button. |
| **Effort / thinking level** | Bottom-right cluster, left of model | Closed pill showing **`Medium`** (default). Agent note: **reasoning / effort / thinking level**. Opens a **generic dropdown** with options: `off` / `low` / `med` / `high` / `xhigh` / `max`. Which options are enabled depends on the selected model / backend — **do not invent backend rules**; disable or hide unavailable levels via whatever the backend/model reports. Closed label may stay title-case (`Medium`) while menu items use the short labels above. |
| **Model picker** | Right of effort | Closed pill showing **`Claude opus 5.5`**. Opens the model dropdown (§2.4). Agent note: **switch between models, or auto; implement auto later** — ship model switching now; **Auto** can be stubbed/deferred. |
| **Mic / dictation** | Circular dark button, left of Send | **Microphone** icon (stroke, light on dark). Toggles dictation via the browser's Web Speech API (in Safari on macOS/iOS this is Apple's own speech engine). Live transcript is appended to the input; button turns red and pulses while listening. Browsers without the API get a hint to use OS dictation (Fn twice on Mac, keyboard mic on iPhone). |
| **Send** | Rightmost circular dark filled button | Up-arrow / send icon. |

Both circular icon buttons (mic + send): circular, filled dark (`#1e1e1e` in diagram), light icon, `cursor: pointer`, subtle hover/scale.

**Do not** treat the circular buttons as attach — prior SPEC error. Attach = **`+`** on the left; mic + send = the two dark circles on the right.

### 2.4 Model picker dropdown (as drawn)

When the model pill is open, diagram shows a **two-column dropdown** under the composer:

1. **Header affordance:** Lucide **`list-filter`** icon at the top-left of the panel.
2. **Agent note (not UI):** `# filter models only from chosen API` — filter the model list to models available for the **currently selected API** (ties to API Keys providers).
3. **Left column — API filter chips** (short labels, stacked):
   - `Go`
   - `Plus`
   - `Black`
   - `Zen`
   
   These map to the Opencode providers in Settings → API Keys (`Opencode Go` / `Plus` / `Black` / `Zen`). Selecting a chip filters the right-hand model list.
4. **Right column — model rows** (each row: small **brand/provider icon** + model name). As drawn, top → bottom:
   - `GLM 5.3 Flash`
   - `Claude Opus 5.5`
   - `Deepseek v4.1 Flash`
   - `Gemini 3.8 Flash`
   - `Qwen 3.8 Max`
   - `Grok 4.7`

Closed pill casing (`Claude opus 5.5`) vs list casing (`Claude Opus 5.5`) — match the diagram per surface; do not invent extra models beyond this list unless wired to real API data later.

---

## 3. Screen A — Home / empty chat (“What's on your mind?”)

**Diagram region:** left large frame.

### Layout

- Sidebar as §2.2.
- Main pane **empty state**:
  - Centered (horizontally in main pane, vertically in the upper-middle of the pane — **not** pinned to the bottom):
    - Large heading UI copy: **`What's on your mind?`**
    - Composer card **directly below** the heading (same centered column).
  - Substantial empty space below the composer toward the window bottom (diagram intent: centered empty state, not bottom-docked).

### Interactions

- Submit (Send or Enter — subject to General setting §5.3) creates/sends a chat and transitions to **Screen B**.
- **New chat** resets to this empty state.
- **Settings** opens modal.

---

## 4. Screen B — After sent message (active chat)

**Diagram label (agent note):** `# after sent message`

### Layout

- Same sidebar as Screen A.
- **Main pane:**
  - **Chat messages area** (agent note: `# actual chat area`) — occupies the upper/middle main pane. Diagram uses scribble placeholders for messages; implement a real message list (user + assistant bubbles/blocks). Do not show the scribble art.
  - **Bottom-docked composer** (same chrome as §2.3: `+` attach, effort `Medium`, model `Claude opus 5.5`, mic, send).
  - Above the composer (when applicable): contextual **think harder / think faster** control (§4.1).

### 4.1 Think harder / Think faster (agent note → behavior)

Agent note (verbatim intent):

> If it used fast, prompt to “think harder” to resend that to the higher quality models, in case the output wasn’t good. And if it used the higher quality model, **WHILE** it’s thinking have a “think faster” button to cancel and send to the faster one to speed the answer up. The **“think faster”** only appears **WHILE the agent is working** and disappears after; the **“think harder”** only appears **after the agent finished** its response.

**UI as drawn — post-response (fast path): `think harder`**

- Rounded outlined button (~same size as the paired control).
- Leading **Lucide `lightbulb`** icon + label UI copy: **`think harder`**
- Sits above the composer, left-aligned with the composer column.

**UI as drawn — in-progress (slow path): `think faster`**

- Diagram callout agent note: `# how the "think faster" should look like` (arrow to the button).
- **Same chrome** as `think harder`: rounded outlined button, icon + label, same overall size/placement language.
- Leading **Lucide `zap`** (lightning bolt) icon + label UI copy: **`think faster`**
- Visible **only while** a higher-quality model response is in progress; cancels and re-sends to a faster model; **hides when generation ends**.

Exact model IDs for “fast” vs “higher quality” are not in the diagram — wire to whatever model list / router the app uses; if unknown, expose clear hooks and flag in code comments.

---

## 5. Settings modal

**Agent note:** `# Pop up, depth of field + blur`

### 5.1 Shell

- Opens from sidebar **Settings**.
- **Backdrop:** blurred + dimmed view of the underlying app (depth-of-field). Diagram shows scribbled “blurred” content behind the card — implement real CSS blur (`backdrop-filter` / filtered clone), not scribbles.
- **Modal card:** centered rounded rectangle; contains:
  - **Left nav rail** (~110px): vertical stack of section buttons.
  - **Right content panel:** section body.

### 5.2 Left nav (all sections)

UI copy labels (exact):

1. `Profile`
2. `General`
3. `API keys` / `API Keys` — diagram varies casing (`API keys` vs `API Keys`); **normalize to `API Keys`** in nav for polish, unless matching the diagram’s per-screen casing is preferred — see Ambiguities.
4. `Appearance`

**Behavior:** click switches content panel. Active item: subtle selected gray background + hover states on all items. `cursor: pointer`.

Diagram draws all four items on every settings variant; only the **content** changes.

---

### 5.3 Section: Profile

**Content heading (UI, markdown look):** `# Profile`  
Render as a markdown-style H1: leading `#`, then title, with a **prominent underline** beneath the heading rule (diagram: thick underline under the heading).

**Body:**

1. **Avatar**
   - Large circular avatar image.
   - Small **pencil** (Lucide `pencil`) edit affordance overlapping bottom-right of avatar — change photo.
2. **Name field**
   - Label (markdown look): `#Name` with light underline under the label.
   - Value input example shown: `Shade`
3. **Bio field**
   - Label: `#Bio` with underline.
   - Multiline textarea. Example UI content as drawn:
     ```
     I'm a developer, learning design and
     open source. please use proper formatting.
     bullet points and tables. never use emojis.
     ```
4. **Location field**
   - Label: `#Location` with underline.
   - Value example: `Germany, frankfrut` (preserve as sample/default text from diagram; do not “fix” unless product copy pass says so).
5. **Language field**
   - Label: `#language` with underline (diagram uses lowercase `language`).
   - Value example: `English, German`

Field chrome: simple outlined rounded inputs (Name single-line; Bio taller multiline; Location & Language single-line).

---

### 5.4 Section: General

**Heading (UI, markdown look):** `# General` + thick underline.

**Rows (top → bottom), each with label left and control right; thin separators between blocks:**

#### Row A — Enable Auto Scroll
- Label UI copy: `Enable Auto Scroll`
- **Toggle switch** (diagram: dark track, white knob on the **ON** side) — default **on** as drawn.

#### Row B — Require Cmd+Enter To Submit
- Label: `Require Cmd+Enter To Submit`
- Helper text under label:
  ```
  When enabled, press Cmd+Enter (or Ctrl+Enter) to submit.
  Enter will add a new line.
  ```
- Toggle — default **on** as drawn.

#### Row C — Auto model router
- Label: `Auto model router`
- Adjacent small caption UI copy: `*experimental`
- Toggle — default **on** as drawn.
- Description under label:
  ```
  Automatically route requests to the right model for the
  cheapest options that fit the quality required for the prompt.

  easier questions go to faster and cheaper models, while more
  complex questions such as code, math, and science related
  questions will be routed to higher quality models.
  ```
- When enabled (as drawn), show chip editors below:

**models to avoid:**  
Chip/tag list. Diagram chips: `Deepseek v4.1 flash`, `GPT 6 Luna`.

**models to prioritize:**  
Chip/tag list shown as **paired** entries (short connector line between pair members, commas between pairs):

| Model chip | Paired tag chip |
|---|---|
| `Qwen3.8 flash` | `Speed` |
| `claude Opus 5.5` | `complex` |

Implement as editable chip lists (add/remove). Exact add-chip UX not drawn — use a clean premium chip input (typeahead or “+” to add) without inventing extra settings pages.

---

### 5.5 Section: API Keys

**Heading (UI, markdown look):** `# API Keys` + thick underline.

**Rows** — four providers, each:

| Provider label (UI) | Secret field | Action |
|---|---|---|
| `Opencode Go` | Masked `**********************************` | `replace` button |
| `Opencode Black` | Masked asterisks | `replace` |
| `Opencode Plus` | Masked asterisks | `replace` |
| `Opencode Zen` | Masked asterisks | `replace` |

Thin horizontal separators between rows.

**Agent note on `replace`:** edits the API key; **focuses that input field**.  
Behavior: clicking `replace` focuses the corresponding secret input and allows overwrite (optionally clear+focus). Do not navigate away.

---

### 5.6 Section: Appearance

**Heading (UI, markdown look):** `# Appearance` + thick underline.

**Theme row:**
- Label UI copy: `Theme`
- Segmented control / three pills on the right:
  - `light`
  - `dark`
  - `system`
- **Default = `system`**. Selected pill: filled/emphasized; others outlined. Hover + `cursor: pointer`.

Thin separator under the Theme row. No other Appearance controls are drawn — **do not invent** font size, density, etc.

---

## 6. Markdown-style headings (UI rendering rule)

Several settings labels use a **rendered markdown look**:

- Section titles: `# Profile`, `# General`, `# API Keys`, `# Appearance`
- Field labels: `#Name`, `#Bio`, `#Location`, `#language`

**Implement as:**

- Visible `#` prefix (or styled equivalent that reads as markdown H1),
- Title text,
- **Nice underline** under the heading/label (section titles = stronger/thicker rule; field labels = lighter thinner rule),

Matching the diagram’s “underived/rendered markdown” intent. These are **UI**, not agent notes.

---

## 7. Agent notes index (do not render in UI)

| Note | Means |
|---|---|
| `# after sent message` | Labels Screen B |
| `# actual chat area` | Messages region on Screen B |
| `# switch between models, or auto, we'll implement auto later` | Model picker; defer Auto |
| `# reasoning/effort/thinking level` | `Medium` effort control / dropdown |
| `# filter models only from chosen API` | Model dropdown filters list by selected API chip (Go/Plus/Black/Zen) |
| `# if it used fast… think harder / think faster…` | §4.1 behavior |
| `# how the "think faster" should look like` | Drawn `think faster` button: Lucide `zap` + label, same chrome as `think harder` |
| `# Pop up, depth of field + blur` | Settings modal backdrop |
| `# edits the api key, focuses on that input field` | `replace` button behavior |
| Arrow from sidebar Settings downward | Settings opens the modal |

Notes that look like `# Profile` / `#Name` **inside the settings content panel** are **UI copy** (see §6), not agent notes.

---

## 8. Navigation & state flows

```
[Screen A: Home]
  New chat → stay/reset Home
  Send message → Screen B
  Settings → Modal (last section or Profile)

[Screen B: Active chat]
  New chat → Screen A
  Settings → Modal
  think harder (after fast response) → resubmit prior turn to higher-quality model
  think faster (while slow response streaming) → cancel & resubmit to faster model

[Settings Modal]
  Nav: Profile | General | API Keys | Appearance
  Backdrop click / Esc → close (recommended; not drawn — standard modal UX)
  Theme change → apply immediately across app
```

---

## 9. Visual structure checklist (1:1)

- [ ] Sidebar ~18–19% width; main pane remainder
- [ ] OpenChat brand + sidebar icon + hamburger
- [ ] New chat button with icon
- [ ] Search placeholder `Search your chats...`
- [ ] Settings at sidebar bottom with avatar mark
- [ ] Home: large `What's on your mind?` + centered composer
- [ ] Active chat: message area + bottom composer
- [ ] Composer L→R: **`+` attach** (left), effort pill, model pill, **mic** circle, **send** circle
- [ ] Effort dropdown: `off` / `low` / `med` / `high` / `xhigh` / `max` (default closed label `Medium`; availability model/backend-dependent)
- [ ] Model dropdown: list-filter + API chips `Go`/`Plus`/`Black`/`Zen` + model rows with brand icons
- [ ] `think harder` lightbulb button above composer when applicable
- [ ] `think faster` **zap** button above composer while generation in progress (as drawn)
- [ ] Settings modal with blur backdrop + left nav + content
- [ ] Profile: avatar+pencil, `#Name`/`#Bio`/`#Location`/`#language` fields
- [ ] General: three toggles + auto-router copy + avoid/prioritize chips
- [ ] API Keys: four Opencode rows, masked, `replace`
- [ ] Appearance: Theme `light` | `dark` | `system` — **default `system`**
- [ ] **Exact Lucide icons** for every glyph (match Excalidraw Lucide names)
- [ ] Premium hover, pointer, transitions, modal blur everywhere interactive

---

## 10. Ambiguities / unknowns (do not invent beyond hooks)

1. **Effort levels:** dropdown options specified as `off` / `low` / `med` / `high` / `xhigh` / `max`; **which are available depends on model/backend** — do not invent backend gating. Closed pill shows `Medium` by default.
2. **Model list:** drawn set in §2.4; live list may later come from APIs — don’t invent extras beyond the diagram unless data-driven. **Auto** still deferred.
3. **Fast vs high-quality model mapping** for think harder/faster — not named.
4. **Chat history rows:** none drawn — empty list OK.
5. **`API keys` vs `API Keys` casing** in nav — inconsistent in diagram.
6. **Prioritize chips:** pairs `(model, Speed|complex)` inferred from connectors; editing UX not drawn.
7. **Theme default:** **`system`** (product decision / correction; diagram does not mark a filled selection).
8. **Location typo** `frankfrut` — sample data as drawn.
9. **Backend/API:** no auth, streaming, or persistence details in diagram — frontend may mock.
10. **Mic / dictation:** Web Speech API dictation into the input; falls back to an OS-dictation hint where unsupported.
11. **Attach (`+`) behavior:** icon drawn; exact file-type picker / paste UX not drawn — use a standard attach file picker without inventing extra panels.

---

## 11. Suggested implementation stack (non-prescriptive)

Use whatever the repo already uses. If greenfield: React/Next (or Vue/Svelte) + Tailwind + Lucide icons + CSS `backdrop-filter` for modal blur is sufficient. Prefer accessible toggles, dialogs, and focus management.
