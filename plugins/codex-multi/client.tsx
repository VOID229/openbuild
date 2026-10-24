// pi-codex-multi's second ChatGPT/Codex login is a Pi provider of its own, "openai-codex-2". Pi
// doesn't ship that provider, so its models would land in the catch-all Custom group. Giving the
// provider a group named after itself moves those models out of Custom, and the icon override
// paints ChatGPT's mark with a small "2" badge so the second login reads as Codex — visibly
// different from the first one — in the rail, the model list and the composer pill.
//
// The mark is the same one OpenBuild uses for OpenAI and Codex (src/assets/brands/openai.svg),
// scaled down to leave room for a solid square badge whose "2" is cut out of it. Cutting the digit
// out (rather than painting it in a guessed background colour) keeps the badge legible on light,
// dark and hover backgrounds alike.
//
// `_R_0_` is replaced by the host with a unique id per rendered icon, so the two mask references
// can't collide when the same icon is on screen more than once.
const CODEX2 = `<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><defs><mask id="codex2-cut-_R_0_" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/><rect x="12.55" y="12.55" width="12.5" height="12.5" rx="2.2" fill="#000"/></mask><mask id="codex2-two-_R_0_" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="13.6" y="13.6" width="10.4" height="10.4"><rect x="13.6" y="13.6" width="10.4" height="10.4" fill="#fff"/><path d="M15.6 17.3C15.6 16 16.5 15.3 17.7 15.3C18.9 15.3 19.9 16.1 19.9 17.3C19.9 18.2 19.4 18.9 18.7 19.6L15.6 22.1H21.3" fill="none" stroke="#000" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><g mask="url(#codex2-cut-_R_0_)" transform="scale(0.82)"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></g><rect x="13.6" y="13.6" width="10.4" height="10.4" rx="1.8" mask="url(#codex2-two-_R_0_)"/></svg>`;

export default {
  // The group is the provider's own id, so the rail tooltip and the row label come from `name`.
  providers: {
    "openai-codex-2": { group: "openai-codex-2", name: "Codex (2)" },
  },
  icons: {
    providers: { "openai-codex-2": CODEX2 },
  },
};
