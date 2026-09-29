# Changelog — StockTake (English)

> This is the English changelog and covers the publicly released versions (0.9.3 onward).
> The full internal history of earlier versions (0.9.2 and before) stays in the Simplified
> Chinese [`CHANGELOG.md`](CHANGELOG.md); the Traditional Chinese version is
> [`CHANGELOG.zhTW.md`](CHANGELOG.zhTW.md).

## 0.9.6 — 2026-09-30 · MIT license + documentation formatting fixes

### Changed
- **Licensed under MIT instead of "All Rights Reserved".** You are now free to use, modify and
  redistribute this addon as long as the copyright notice is kept. Source repository:
  <https://github.com/tatechen88/StockTake>.

### Fixed
- **Broken code blocks in the Simplified Chinese and English READMEs.** The code fences in those two
  files had been written as `///` and inline-code backticks as `/` (so `/st` showed up as `//st/`),
  left over from a text-transfer accident. Both are now restored line by line from the unaffected
  Traditional Chinese version, which was correct all along.

### Added
- **In-game screenshots in the README**: one of the tooltip, one of the options panel (character
  names mosaicked).

### Note
- This release **only changes the license and the documentation**. Counting logic and data format are
  identical to 0.9.5; no migration needed.

---
## 0.9.5 — 2026-09-28 · Options panel: language and font-size initialisation (3 fixes)

### Fixed
- **The options panel and its settings category now follow your saved language.** The panel's title,
  hint line, checkbox and slider text used to be bound while the addon's files were still loading -
  before SavedVariables exist - so a language override never reached them and the panel stayed in the
  client language. Core now fires an internal `DB_READY` event once the saved variables are ready,
  and Options builds the panel and registers the category only then.
- **The font-size slider starts at your saved value.** Previously it always started at "Follow game"
  even when a custom size was stored, until you moved it once.
- **`/st en`, `/st zh`, `/st tw` and `/st auto` relabel the panel instantly - no `/reload` needed.**
  The switch used to write the saved variable directly, bypassing `SL:Set` and its `CONFIG_CHANGED`
  event, so the stored value and the tooltip changed while the panel text did not. The character
  filter section (its header and the "(current character, always shown)" suffix) is now part of the
  relabel as well. The sidebar category name still follows on the next reload - a limitation of
  Blizzard's settings framework.

### Added
- **Traditional Chinese**: a new `zhTW` string table, written for the
  client's wording rather than converted character-by-character (設定 / 字型 / 戰隊銀行 / 列 / 登入 /
  紀錄 / 記憶體 / 快取 / 預設 / 指令). It is selected automatically on a Traditional client and can be
  previewed with `/st tw`; the TOC now carries `Title-zhTW` and `Notes-zhTW`.
- **Documentation in three languages**: `README.md` (Simplified Chinese), `README.zhTW.md`
  (Traditional Chinese) and `README.en.md` (English).

### Note
- This release only changes when the options panel is built and how language refreshes work.
  **Counting logic, data format and SavedVariables are identical to 0.9.4** - upgrading needs no migration.

---

## 0.9.4 — 2026-09-28 · Short command /st + addon-list icon + settings consolidation + 7 fixes

### Changed
- **Short command `/sl` → `/st`** (the long alias `/stocktake` is unchanged). Every installed addon's
  slash registrations were scanned beforehand to confirm `/st` was free.
- **Settings consolidated: the "Show other characters" checkbox was removed.** It duplicated the
  per-character "Which characters to show" list - unchecking everything already means "only yourself".
  The list is now the single control, and the obsolete `showOthers` key is deleted from saved
  variables on load.
- User-visible text updated to match in every language (options hint, locale messages, READMEs,
  and the CurseForge project description).

### Added
- **Addon-list icon**: `Media\StockTake-Icon.tga` (128x128, 32-bit TGA with alpha) declared through
  `## IconTexture`, so the in-game addon list finally shows an icon. The artwork was validated at
  real display sizes: the bubble variant blurs below 24 px, so the shipped icon is the simplified
  "dark rounded tile + large gold 27" variant.

### Fixed
- **Bank counts no longer go stale while the bank stays open** (the most important fix here).
  The bank used to be scanned only at the moment `BANKFRAME_OPENED` fired; deposits, withdrawals and
  rearranging afterwards only triggered `BAG_UPDATE_DELAYED`, which rescanned bags only - so a
  character's saved bank figure stayed at the value from when the bank was opened, and other
  characters saw a wrong "bank" and "Total". While the bank is open, bag updates now refresh the bank
  snapshot too (a new `BANKFRAME_CLOSED` listener clears the state).
- **"Follow game" now restores the font sizes it changed.** Returning the slider to 0 previously only
  stopped new writes; lines already resized kept the custom size. Original fonts are now recorded and
  rolled back.
- **The font slider's 1-5 positions snap to 6** - the renderer clamps anything below 6, so those five
  positions showed one number and rendered another.
- **Equipped items no longer count toward "bags".** `C_Item.GetItemCount`'s base count includes worn
  equipment (wearing one ring with empty bags showed "bags 1"); equipped counts are now subtracted,
  and "bank" is unaffected.
- **A never-executed fallback now works**: `GetRegions` returns multiple values rather than a table,
  so the old code captured only the first return and its font pass over unnumbered FontStrings could
  never run.
- **An already-open tooltip refreshes in place** when counts or font size change (previously it kept
  the old numbers until you hovered again).
- **A bank that reads as empty is double-checked** before overwriting a non-empty snapshot (a slot
  count proves the tab exists, not that its items are readable yet).

---

## 0.9.3 — 2026-09-27 · Folder and release package unified as StockTake + CurseForge metadata

### Changed
- **Addon folder `StackLedger/` → `StockTake/`**, `StackLedger.toc` → `StockTake.toc`. The CurseForge
  project is named **StockTake** while the download, folder and TOC were still `StackLedger`, so what
  users saw never matched the folder name.
- Release packages became **`StockTake-<version>.zip`** with `StockTake/` as the top-level folder.
- The long slash command changed from **`/stackledger` to `/stocktake`**.
- `## Author` changed from the placeholder `StackLedger` to **`Tate_Chen`**.

### Upgrade notice (data impact)
- **WoW names the SavedVariables file after the addon folder**, so `StackLedger.lua` under
  `WTF\Account\<account>\SavedVariables\` became `StockTake.lua`: **old records are not read, which
  means starting from zero**.
- It heals itself: log each character in once (bags) and open their bank once. To migrate manually,
  simply rename the old `StackLedger.lua` to `StockTake.lua` (the internal variable `SL2_DB` is
  unchanged and is read as-is).
- **After upgrading, make sure no leftover `StackLedger` folder remains** under
  `Interface\AddOns\` - having both loaded draws the count block twice.

### Added
- **`## X-Curse-Project-ID: 1714499`** and **`## X-Website`**: CurseForge project identifiers so
  updater clients can map the local folder to the online project.
