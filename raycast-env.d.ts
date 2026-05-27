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
  /** Refresh Interval - How often to refresh the server list */
  "refreshInterval": "2" | "5" | "10" | "30",
  /** Project Display - Show the full path instead of the project name */
  "showFullPath": boolean,
  /** Row Accessories - Show how long each server has been running */
  "showUptime": boolean,
  /** undefined - Show the current git branch next to each server when the project is a git repo */
  "showBranch": boolean,
  /** undefined - Show the framework / tool tag (Vite, SvelteKit, Astro, etc.) on each row */
  "showTool": boolean,
  /** undefined - When a custom domain (e.g. via portless) points at a dev server, also show the localhost:PORT pill alongside it */
  "showLocalUrl": boolean
}
  /** Preferences accessible in the `start` command */
  export type Start = ExtensionPreferences & {
  /** Terminal App - Which terminal to open when using "Open in Terminal". Defaults to macOS Terminal if unset. */
  "terminalApp"?: import("@raycast/api").Application,
  /** After Start - Once the new dev server starts listening, automatically open its URL in your default browser */
  "autoOpenInBrowser": boolean,
  /** Confirmations - Show a confirmation alert before spawning more than one dev server from a multi-folder Finder selection */
  "confirmMultiStart": boolean
}
}

declare namespace Arguments {
  /** Arguments passed to the `index` command */
  export type Index = {}
  /** Arguments passed to the `start` command */
  export type Start = {}
}

