# StockTake

> Written for the veteran who still logs onto alts just to check how many of something you actually own.

## Why you'll want it

After all these years, your bank isn't "one character's bank" — it's **one account's bank**. Flasks on the druid, ore in the mage's bags, and a pile of gems sitting in the warband bank. Wanting to know "how many of these do I actually have?" used to mean character-switching and bag-digging, or installing something the size of BagSync.

This addon does exactly one thing: **hover over an item, and it tells you who's holding how many, account-wide**. Install and go — no setup wizard, no libraries, 5 files and ~30 KB.

## What it looks like

Hover any item (bags, bank, auction house, chat links — all work), and a few lines appear after the game's own description:

```
Void-Touched Rune
Item Level 350
Use: Increases Intellect by 25 for 1 hr.
"Can be bought and sold on the Auction House."
                        ← blank line, kept apart from the game's text
Oldman:  27     (bags 20 · bank 7)
                        ← red line under YOUR row — find yourself at a glance
Frostfire Vow:  12     (bags 12)
Ironforge Guard:   3     (bags 3)
Total: 42
                        ← another blank line; other addons' lines go below
Sell Price: 264g 96s 20c
```

![StockTake: tooltip in game (Simplified Chinese client; character names mosaicked)](docs/images/tooltip-zhcn.png)

A few details that only come from actual play:

- **Your current character is always the first row**, with a red line under the name — you always know which one is you;
- **The parentheses line up in a perfect column** — 3 / 12 / 170 digits wide, nothing drifts, because it's a pixel-aligned column, not space-padding;
- **"bank" already includes the warband bank.** Nothing in the account bank goes missing, and nothing gets double-counted with your character bank — no more mental math about "how many are in the warband";
- Character names are **class-colored**, same habit as your raid frames;
- The block sits **after the game's own description, before other addons' lines** (Auctionator's sell price and friends) — no scrolling to the bottom of a long tooltip to find the counts.

## Options (two things, and that's already plenty)

**ESC → Options → AddOns → StockTake**, or just `/st`:

| Option | Description |
|---|---|
| Show total line | That "Total: 42" row — off if you don't want it |
| Tooltip font size | The size of the **whole tooltip** (including the game's own text). Default "Follow game" = changes nothing until you touch it |

Below that is the **"Which characters to show"** list — it is the one control for other characters: abandoned alts or deleted characters still keeping records? Uncheck them and the tooltip cleans up instantly; **uncheck everything to see only yourself**. Your current character is always shown — that's your mainline data, you can't turn it off.

![StockTake: settings panel (English client; character names mosaicked)](docs/images/settings-en.png)

## Questions veterans actually ask

**Why do some of my characters show no count?**
Each character needs to **log in once** to be recorded (bags on login, bank when you open it). Log onto that new alt once and it's there.

**How is the warband bank counted?**
Folded into your current character's `bank` number via Blizzard's official `includeAccountBank` parameter — accurate in real time. Other characters only count their own character bank, so the total never double-counts.

**Where is the data stored? How do I reset it?**
`WTF\Account\<account>\SavedVariables\StockTake.lua` — item IDs and numbers only, no names or icons, no network. For a clean slate, delete that file while the game is closed.

**Will it fight my UI suite?**
By default it only **adds its own lines** to the tooltip — no scaling, no touching other addons' lines. The one exception is the font-size slider — it's global (as requested); if you run a skin addon that also restyles tooltip fonts, the two may overwrite each other. Leave the slider at "Follow game" and everyone gets along.

**Does it use much memory? How do I slim it down?**
Very little while running: the hover-result cache has a hard cap (128 entries at most — the oldest get evicted automatically), so it won't slowly grow over a long session. What does accumulate with each character is their recorded bag/bank lists — `/st clean` removes characters you haven't logged onto in a while (30 days by default; `/st clean 60` for 60 days) in one go. Note it only clears the records of characters who haven't been online; for a true clean slate, still delete the SavedVariables file with the game closed (see above).

**Want to see another language?**
Three languages are built in: `/st zh` Simplified Chinese, `/st tw` Traditional Chinese and `/st en` English — **all switch instantly (no reload)**; `/st auto` follows the client again. A Traditional Chinese client picks Traditional automatically.

## Install

Drop the `StockTake` folder into `World of Warcraft\_retail_\Interface\AddOns\`, restart the client or `/reload`. That's all.
(The addon shows up in your addon list as **StockTake**; the folder name is just an internal identifier.)

---

*If all you want is to quietly check a number, it'll be a handy tool.*
