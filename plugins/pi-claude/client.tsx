// `group` changes the provider bucket its models are listed under; the app already knows the
// "claude" provider's name and logo. Without this, Pi's pi-claude models (not a Pi built-in) fall
// into the Custom group.
export default {
  providers: {
    "pi-claude": { group: "claude", name: "Claude" },
  },
};
