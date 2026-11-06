// Localization: assets/strings.json, the nine StarHermit locales with English text
// as the key, on the engine's string tables, which follow the runtime's interface
// language (the player's choice in Options › Language, else the account's preferred
// language or the device's) along their locale chains. The account lines are the
// engine's `starhermit.*`.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export function currentLocale(): string { return strings.locale; }
/** fn() after the interface language changed. */
export function onLocaleChange(fn: () => void): void { strings.onChange(fn); }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function tr(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key translated with tr() where it is shown. */
export const N = (s: string): string => s;
