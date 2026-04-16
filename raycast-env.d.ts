/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `index` command */
  export type Index = ExtensionPreferences & {
  /** Terminal App - Which terminal to open when using "Open in Terminal". Defaults to macOS Terminal if unset. */
  "terminalApp"?: import("@raycast/api").Application,
  /** Project Display - Show the full path instead of the project name */
  "showFullPath": boolean,
  /** Refresh Interval - How often to refresh the server list */
  "refreshInterval": "2" | "5" | "10" | "30"
}
}

declare namespace Arguments {
  /** Arguments passed to the `index` command */
  export type Index = {}
}

