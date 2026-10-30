// Copy to openbuild.config.ts (in the repo root or OpenBuild's data folder) to change where plugins
// and custom CSS live. Everything here is optional; the defaults work with no config file.
export default {
  // Folders with plugin.json. Relative paths are resolved from this file.
  // Default: <data dir>/plugins, outside the installation.
  // Leave unset to keep plugins independent of updates.
  // pluginsDir: "/absolute/path/to/my/plugins",

  // Global CSS applied after OpenBuild's styles, for tweaks that aren't a plugin.
  // Default: <data dir>/custom.css, if it exists.
  customCss: "custom.css",

  // Start with every plugin off. Same as OPENBUILD_SAFE=1.
  safeMode: false,

  // Plugins that can't be enabled from Settings.
  disabledPlugins: [],
};
