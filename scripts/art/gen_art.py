#!/usr/bin/env python3
"""The painted art's generation pipeline.

Drives the image tool of the Codex CLI (gpt-image-2) once per asset with a structured prompt spec,
writing full-size PNGs to art-src/originals/ (git-ignored; optimize.py turns them into the WebP files
in public/art/). Usage:

    python3 scripts/art/gen_art.py --list
    python3 scripts/art/gen_art.py dev_knight             # one asset
    python3 scripts/art/gen_art.py --group icons -j 3     # a group, 3 in parallel
    python3 scripts/art/gen_art.py --all -j 3 --skip-existing
    python3 scripts/art/gen_art.py venture_rally --dest /tmp/take2   # a take beside the shipped one

To paint the six newest ventures (Salvage, Pilot, Trade Wind, Customs, Stockpile, Lighthouse):
  prerequisites: the Codex CLI installed and signed in (`codex login`; CODEX_BIN overrides the binary),
  with its built-in image tool (gpt-image-2), and art-src/originals/cards/vp_chapel.png as the style anchor.
    python3 scripts/art/gen_art.py venture_salvage venture_pilot venture_tradeWind venture_customs venture_stockpile venture_lighthouse -j 3
    uv run --no-project --with pillow python scripts/art/optimize.py ventures --only salvage pilot tradeWind customs stockpile lighthouse
  (look over art-src/originals/ventures/*.png first; re-run a name with --dest /tmp/take2 for another take).
  Then, in src/game/names.ts, add the ids you painted to OWN_VENTURE_ART (all six: their ids as strings);
  `npx vitest run tests/art.test.ts` checks every file is there.

CODEX_BIN names the Codex CLI (default: `codex` on the PATH). Style references (-i) keep the set
consistent: the base illustrated cards reference the knight anchor, and the expansions' scenes a
figureless anchor of their shape (the chapel, the long road) so that no livery or face is copied
from it.
"""

import argparse
import concurrent.futures as cf
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "art-src", "originals")
LOGS = os.path.join(ROOT, "art-src", "logs")
CODEX = os.environ.get("CODEX_BIN", "codex")

# Style direction (revised after research on avoiding the "AI look"): name a concrete hand-made
# medium, keep the palette restrained and natural, avoid quality buzzwords, glow effects and
# clutter, and keep forms simple enough to read at card size.
STYLE = (
    "traditional gouache illustration in the manner of classic European board-game card art: visible brushstrokes, "
    "slight watercolor-paper grain, soft hand-drawn edges, simplified readable forms, matte finish; "
    "restrained natural palette, colors slightly muted rather than saturated; moderate detail only"
)
LIGHT = "soft, even late-morning daylight from the upper left, gentle natural shadows, calm and clear"
DUSK = "soft, even blue dusk after sunset, the lantern the only warm light, gentle natural shadows, calm and clear"
AVOID = (
    "no glow, no bloom, no lens flare, no sun rays, no bokeh, no depth-of-field blur, no orange golden-hour cast, "
    "no glossy or plastic surfaces, no 3D-render look, no excessive tiny detail or clutter, no perfect symmetry"
)


CARD_STYLE = STYLE

CARD_COMMON = dict(
    use_case="stylized-concept",
    asset_type="full-bleed illustration for the art window of a portrait development card in a browser board game set on a green island",
    style=CARD_STYLE,
    composition=(
        "a full-bleed scene that fills the entire canvas edge to edge with its own natural ground and sky; "
        "NOT a diorama, NOT on a hexagon, no tile, no base, no plinth, no cross-section, no floating island; "
        "simple, asymmetric composition with one clear focal subject in the middle 70 percent so it survives a rounded-rectangle crop, "
        "calm background with room to breathe"
    ),
    lighting=LIGHT,
    constraints="no text, letters, numbers, signatures, watermarks, logos, borders or frames; no hexagonal shapes; " + AVOID,
)

# The expansions' scenes (awards, ventures, muster, happenings). The first batch referenced the
# knight anchor, and its blue surcoat with a gold lion was copied as content: one livery stood for
# every officer, guard and banner, and blue reads as the blue player's colour on a table where
# colour means ownership. So these scenes forbid heraldry, name any livery's colours in the subject
# or palette (never red, blue, white or orange, the seats' colours), and reference a figureless
# anchor of the right shape (SCENE_REF) unless armour is the subject.
SCENE_COMMON = dict(CARD_COMMON)
SCENE_COMMON["constraints"] = (
    "no heraldry: no lions, eagles, fleurs-de-lis, coats of arms or crests on any banner, shield, surcoat or cloth; "
    "any livery, tabard, banner or surcoat is plain or in the colours named in the subject or palette; "
    "the people are ordinary islanders of varied ages, builds and faces, not a recurring character; "
    + CARD_COMMON["constraints"]
)
SCENE_REF = {"1024x1536": "vp_chapel", "1024x1024": "bonus_longestRoute"}

# Each guild's ventures carry its colours as their accent, so a hand of ventures sorts by colour
# as well as by the band down each card's edge (the UI's track colours, `.vh-card.track-*`) and
# matches its commodity and its seat's painting: learning is paper and the scholar's blue, commerce
# cloth and gold, statecraft silver and the councillor's plum.
GUILD_ACCENT = {
    "learning": "accents of deep slate-blue and cream",
    "commerce": "accents of rose and gold",
    "statecraft": "accents of plum and silver-grey",
}


ICON_COMMON = dict(
    use_case="stylized-concept",
    asset_type="small game UI resource icon shown at 32 to 96 pixels on a parchment interface",
    style="small gouache-painted game icon with visible brush texture, simple shapes, a bold readable silhouette and a restrained natural palette",
    lighting="soft daylight from the upper left",
    composition="single object centered, three-quarter view, filling about 85 percent of the canvas",
    constraints="genuinely transparent background (alpha), no shadow box, no text, numbers, borders or frames; " + AVOID,
)

# The HUD shows the expansions' tokens at 17 to 40 px, on the parchment panels and on dark chips, so
# brown on brown or cream on cream vanishes at one end or the other (the first paper, prisoner, boot
# and oil icons did). These specs ask for value contrast inside the object and a darker edge.
SMALL_ICON = dict(ICON_COMMON)
SMALL_ICON["asset_type"] = (
    "small game UI token icon shown as small as 17 to 40 pixels, both on a light cream parchment panel and on a dark brown chip"
)
SMALL_ICON["style"] = (
    ICON_COMMON["style"] + "; a strong light-and-dark value contrast within the object and a clear darker edge, "
    "so that the silhouette holds against both a light and a dark ground"
)

PORTRAIT_COMMON = dict(
    use_case="stylized-concept",
    asset_type="circular player avatar for a computer opponent in a board game",
    style="gouache portrait illustration with visible brushstrokes and paper grain, natural proportions, warm but muted palette, matte",
    lighting="soft window daylight from the upper left",
    composition="head-and-shoulders bust, face centered slightly above middle, three-quarter view, friendly expression, plain soft warm parchment-colored background",
    constraints=(
        "a fictional character, not resembling any real person or celebrity; the shoulders and clothing continue all the way to the "
        "bottom edge of the canvas exactly like the reference portrait; flat, evenly lit parchment background filling the whole canvas; "
        "no vignette, no fade-out, no circular mask, no frame, no text, letters or logos; " + AVOID
    ),
)


def spec(common, size, **kw):
    d = dict(common)
    d.update(kw)
    d["size"] = size
    return d


# One painting per venture, portrait like the development cards, listed by guild: learning leans on
# craft and study, commerce on goods and trade, statecraft on officers, crowds and intrigue. Each
# subject names its own cast (age, build, clothes), because left to itself the model gives every
# merchant the same face, burgundy coat and feathered cap.
VENTURES = {
    "learning": [
        ("augury", "a hooded seer woman on a windy cliff-top at morning, two ivory dice resting in her open palm as she reads a flock of birds wheeling over the sea", "slate blue cloak, ivory, sea greens, pale sky"),
        ("hoist", "a wooden treadwheel crane on a building site hoisting a dressed stone block up to a half-built tower, two workers guiding the rope from the scaffold", "warm timber, honey stone, rope browns, blue sky"),
        ("masonry", "a stocky mason laying cut stones with a trowel to raise a stout new wall around a town of red roofs, a mortar tub and a stack of dressed stones beside him", "warm grey stone, terracotta roofs, earthy browns, fresh greens"),
        ("resurvey", "a surveyor with a brass sighting instrument on a wooden tripod and an assistant holding a striped measuring staff, on a hilltop over a patchwork of fields, hills and forest", "brass, patchwork greens and ochres, red and white staff"),
        ("waterworks", "a stone aqueduct and a wooden water wheel feeding irrigation channels into golden wheat fields, a farmer lifting a small sluice gate", "golden wheat, clear water blue, grey stone, green margins"),
        ("townPlanning", "a town planner unrolling a large drawn plan on a trestle table beside a growing town, where a small cottage is being rebuilt into a tall stone townhouse inside wooden scaffolding", "honey stone, red roofs, timber scaffolding, cream paper"),
        ("deepSeams", "two miners with lanterns and pickaxes in a timbered mine tunnel opening onto a mountainside, a seam of glittering blue-grey ore in the rock wall and a loaded mine cart on rails", "slate grey, lavender rock, blue-grey ore, small warm lantern light"),
        ("pathfinders", "two pathfinders with packs and walking staves driving wooden marker stakes along a new trail over a green ridge, a distant islet and the sea beyond", "fresh greens, earth browns, sea blue, red marker ribbons"),
        ("pilot", "a small wooden pilot boat with a lantern on its mast and two rowers leading a broad-hulled merchant ship with cream sails through a narrow channel marked by striped wooden buoys, a pilot in an oilskin hat standing in the bow and pointing the way, shoals showing pale green on either side", "sea blues, pale shoal green, cream sails, red and white buoys, warm timber"),
        ("salvage", "islanders wading in the surf after a wreck, hauling a wooden crate and a barrel up a sandy beach with ropes, a broken mast and torn sail in the shallows behind them and a heap of rescued bundles on the sand, gulls overhead", "sand, turquoise surf, driftwood browns, torn cream sailcloth"),
        ("forge", "a broad blacksmith, large in the foreground and seen from the waist up, hammering a glowing sword blade on an anvil beside a stone forge whose coals are warm red, plain round shields and helmets hanging on the timber wall of an open-sided smithy behind him", "iron greys, warm red coals, leather browns, daylight through the open side"),
        ("encyclopaedia", "a great leather-bound encyclopaedia lying open on a carved reading stand in a sunlit library, a globe, rolled maps and a quill beside it, plain cream curtains at a tall window onto the sea (the pages show only faint illegible marks)", "leather browns, gold tooling, cream pages, deep green walls"),
    ],
    "commerce": [
        ("barter", "two traders at a country crossroads swapping a basket of fleece for a bolt of rose cloth with a handshake, a laden mule and a small cart beside them", "cream wool, rose cloth, earthy browns, spring greens"),
        ("tribute", "a lean, hawk-nosed tax collector dressed in black with a silver chain of office lifting a gold goblet and a bolt of rose silk out of a stout bald merchant's open chest of goods, while the merchant in a mustard-yellow doublet throws up his hands in dismay, in a sunny courtyard", "black, mustard yellow, warm stone, rich fabric accents"),
        ("trader", "a cheerful, wiry travelling trader in a mustard-gold waistcoat and a rose neckerchief, large in the foreground, waving customers over as he sets up a small stall under a rose-and-cream striped awning, his laden pack mule beside him, at the edge of a village beside the fields", "rose and cream awning, mustard gold, warm wood, golden fields, fresh greens"),
        ("charterFleet", "three merchant ships with cream sails leaving a harbour in a line, a grey-haired merchant woman in a rose cloak on the quay holding up a rolled document tied with a gold cord and a wax seal", "cream sails, sea blues, warm quay stone, a rose cloak, gold"),
        ("cornerMarket", "a broad, smug wool dealer woman in a straw hat and a rose apron sitting with folded arms on top of a towering heap of wool sacks in a market square, while three other traders below look up at her with empty hands and empty baskets", "cream sacks, warm stone, awnings, earthy greens and browns"),
        ("cartel", "three merchants in rich coats clasping hands over a table in a sunny counting house, a stack of paper, a bolt of cloth and silver bars between them", "deep teal, rose, silver, warm wood"),
        ("tradeWind", "a merchant ship with full billowing cream sails and a long pennant streaming straight out from the masthead, leaning into a fresh breeze on a bright sea, a small moored boat and a quay in the foreground with flags and laundry blowing, gulls riding the wind above the harbour", "cream sails, wind-brushed sea blues, bright pale sky, a rose pennant"),
        ("customs", "a stern customs officer in a long dark coat and a flat cap, holding a ledger and a pen, checking a row of crates and barrels on a stone quay while two porters wait with a hand-cart, a moored trading ship behind", "dark teal coat, warm quay stone, timber crates, sea blue"),
        ("stockpile", "the inside of a tall, orderly storehouse with timber beams and a wide open door onto the harbour, neat stacks of rolled bolts of cloth, tied bundles of paper and a pile of silver ingots on a low pallet, a storekeeper in an apron with a lantern checking the shelves", "warm timber, rose and cream cloth, silver, paper cream"),
    ],
    "statecraft": [
        ("rightOfWay", "a young clean-shaven royal officer in a long grey cloak with a plum sash, a halberd in one hand, raising the other to halt a road crew at a striped wooden barrier across a country road, the half-laid road behind them", "silver-grey cloak, plum sash, red and white barrier, stone grey road, fresh greens"),
        ("rally", "a grey-bearded old captain in a plum-and-silver tabard over mail, standing on a low stone wall and raising a plain plum banner to rally a small band of island wardens with spears and plain wooden round shields in a sunny town square", "plum, silver-grey, steel, warm stone, red roofs"),
        ("spymaster", "a sharp-featured spymaster woman in a plum hood leaning in a sunlit stone archway of a busy street, reading a stolen letter, while a messenger boy slips away down the bright alley behind (the letter shows no legible writing)", "warm sunlit stone, the plum hood as an accent, silver-grey, ivy greens, blue sky"),
        ("agitators", "a firebrand speaker, a wiry young man with a plum sash, standing on a barrel and stirring up a small crowd of villagers outside a guard post, a lone guard in a plain grey tabard looking uneasy", "earthy browns, a plum sash, grey stone, fresh greens"),
        ("unrest", "a handcart tipped on its side in a market street, one angry townsman in a leather apron standing on top of it shaking his fist, a small crowd of townsfolk behind him, and a portly official in a plum coat backing away clutching his hat", "warm stone, earthy browns, a plum coat, fresh greens"),
        ("taxCollectors", "two tax collectors with a small iron strongbox knocking at a farmhouse door while the farmer peeks out and his wife hides a sack behind the woodpile", "black and grey coats, warm farmhouse stone, golden straw, greens"),
        ("treachery", "a turncoat guard in a russet leather jerkin and a plain steel cap, glancing back over his shoulder as he secretly hands a ring of iron keys to a cloaked rival, on an open castle walkway with bright sea light coming through the arches", "russet, steel grey, a deep green cloak, pale sunlit stone, sea blues"),
        ("grandCharter", "a great rolled charter tied with a gold ribbon and a large red wax seal, resting on a velvet cushion on a council table before a tall window over the island, plain plum hangings at the window", "red wax, gold ribbon, plum velvet, pale stone, sea blues beyond"),
        ("dowry", "a village wedding in a flowered square: the bride's family, in festive plum and silver-grey clothes, presenting a painted wooden dowry chest of fine cloth and silver to the groom's family, bunting overhead", "plum and silver-grey festive clothes, a painted chest, flowers, warm stone"),
        ("lighthouse", "a tall whitewashed stone lighthouse on a grassy headland at blue dusk, a lit lantern room at its top sending a soft pale beam as a flat painted wedge across the water and over a small green island with a few cottages, a keeper's cottage at its foot and a fishing boat heading home below", "dusk blues, whitewashed stone, soft pale yellow lantern light, sea greens"),
    ],
}

ASSETS = {
    # --------------------------------------------------------- development cards
    "dev_knight": dict(group="dev", ref=None, out="cards/knight.png", **spec(CARD_COMMON, "1024x1536",
        subject="a heroic knight figure on a white horse rearing proudly, steel armor with a blue and gold surcoat, holding a lance with a small pennant, cantering across a sunny grassy headland above the sea",
        palette="steel silver, royal blue, gold, fresh greens",
    )),
    "dev_roadBuilding": dict(group="dev", ref="dev_knight", out="cards/roadBuilding.png", **spec(CARD_COMMON, "1024x1536",
        subject="two cheerful road builders laying a new cobblestone road across green rolling hills (the road is the subject here), one kneeling with a mallet, one pushing a wheelbarrow of stones, a small pile of cobbles",
        palette="warm stone greys, fresh greens, earthy browns, bright work clothes",
    )),
    "dev_invention": dict(group="dev", ref="dev_knight", out="cards/invention.png", **spec(CARD_COMMON, "1024x1536",
        subject="a cheerful inventor in a sunlit timber workshop standing beside a whimsical brass contraption with gears and a tiny spinning waterwheel, a small workbench with a blueprint and tools",
        palette="brass and copper, warm wood, teal accents, fresh greens",
    )),
    "dev_monopoly": dict(group="dev", ref="dev_knight", out="cards/monopoly.png", **spec(CARD_COMMON, "1024x1536",
        subject="a sly, well-dressed merchant in a burgundy coat in a harbor market, hugging an overflowing pile of sacks and crates toward himself beside a small market stall with a striped awning",
        palette="burgundy, gold, warm wood, stripe accents",
    )),
    "vp_chapel": dict(group="vp", ref="dev_knight", out="cards/vp_chapel.png", **spec(CARD_COMMON, "1024x1536",
        subject="a charming small stone chapel with a slender bell tower on a flowery green hilltop",
        palette="warm stone, slate blue roof, spring greens",
    )),
    "vp_library": dict(group="vp", ref="dev_knight", out="cards/vp_library.png", **spec(CARD_COMMON, "1024x1536",
        subject="a handsome little library building with tall arched windows, a book-shaped sign and stacks of books by the door in a green town square",
        palette="honey stone, deep green roof, leather browns, gold",
    )),
    "vp_market": dict(group="vp", ref="dev_knight", out="cards/vp_market.png", **spec(CARD_COMMON, "1024x1536",
        subject="a lively little market square with three stalls under striped awnings full of colorful produce and bunting overhead",
        palette="festive reds, ochres and greens, warm wood",
    )),
    "vp_greatHall": dict(group="vp", ref="dev_knight", out="cards/vp_greatHall.png", **spec(CARD_COMMON, "1024x1536",
        subject="a stately governor's great hall of pale stone with columns, tall windows and small flags on the roof in a green town square",
        palette="pale limestone, slate blue roof, gold trim, green lawn",
    )),
    "vp_university": dict(group="vp", ref="dev_knight", out="cards/vp_university.png", **spec(CARD_COMMON, "1024x1536",
        subject="an elegant little university building with a copper-green observatory dome and a courtyard sundial in a green town square",
        palette="honey stone, copper green dome, ivy greens",
    )),
    "bonus_longestRoute": dict(group="bonus", ref="dev_knight", out="cards/longestRoute.png", **spec(CARD_COMMON, "1024x1024",
        subject="a long winding cobblestone road (the road is the subject here) curving across rolling green island hills to the horizon, a stone milestone and a tiny horse-drawn cart",
        palette="greens, stone grey, earth brown",
    )),
    "bonus_largestArmy": dict(group="bonus", ref="dev_knight", out="cards/largestArmy.png", **spec(CARD_COMMON, "1024x1024",
        subject="three knight figures with raised lances and colorful pennants standing in formation on a grassy hill at sunrise",
        palette="steel silver, multicolor pennants, fresh greens",
    )),
    # --------------------------------------------------------- expansion awards
    # Square like the two base awards: the cards that change hands (and the Pauper tile that's
    # pressed on someone), told with a banner when they move.
    "award_harbourmaster": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/harbourmaster.png", **spec(SCENE_COMMON, "1024x1024",
        subject="a weathered harbourmaster in a navy coat and peaked cap standing on a stone quay with a brass spyglass tucked under one arm, a small busy harbour behind him with a white lighthouse on the breakwater and two moored sailing ships",
        palette="navy, brass, warm quay stone, sea blues, fresh greens on the headland",
    )),
    "award_steward": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/steward.png", **spec(SCENE_COMMON, "1024x1024",
        subject="a calm steward in a moss-green cloak kneeling to plant a young oak sapling on a clean green hillside, beside a stout stone cellar door set into the hill where a row of sealed dark oil barrels is being kept safely out of use, a clear river and blue sea beyond",
        palette="moss and spring greens, dark oak barrels, grey stone, clear blues",
    )),
    "award_seat_learning": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/seat_learning.png", **spec(SCENE_COMMON, "1024x1024",
        subject="the seat of the learning guild: an old scholar in a deep blue robe at a tall lectern with a great open book, a brass armillary sphere beside him, in a bright stone hall with a tall arched window looking out over a green island and the sea",
        palette="deep blue, cream parchment, brass, honey stone, sea greens through the window",
    )),
    "award_seat_commerce": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/seat_commerce.png", **spec(SCENE_COMMON, "1024x1024",
        subject="the seat of the commerce guild: a cheerful, round-faced guild merchant woman with a rose kerchief over her hair and a gold-embroidered bodice, unrolling a bolt of fine rose cloth across a wide counter in a timbered guildhall whose big doors open onto the harbour, bolts of cloth stacked on shelves around",
        palette="rose and magenta cloth, warm timber, gold trim, harbour blues",
    )),
    "award_seat_statecraft": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/seat_statecraft.png", **spec(SCENE_COMMON, "1024x1024",
        subject="the seat of the statecraft guild: a dignified councillor in a silver-grey and plum robe pressing a red wax seal onto a rolled document at a long oak council table, tall plain plum hangings without any emblem behind him and a window onto a hilltop castle",
        palette="silver grey, plum, red wax, dark oak, pale stone",
    )),
    "award_richest": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/richest.png", **spec(SCENE_COMMON, "1024x1024",
        subject="a prosperous river merchant beaming beside an open wooden chest brimming with gold coins on a small barge moored at a sunny riverbank town with a stone bridge",
        palette="gold, burgundy coat, warm wood, river blues and greens",
    )),
    "award_pauper": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/pauper.png", **spec(SCENE_COMMON, "1024x1024",
        subject="a down-on-his-luck traveller in patched clothes sitting on a stone by a riverside path under a willow, ruefully turning out an empty purse, a small bundle on a stick beside him; gentle and a little comic, not miserable",
        palette="faded browns and patched blues, willow greens, soft river blue",
    )),
    "award_defender": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/defender.png", **spec(SCENE_COMMON, "1024x1024",
        subject="island defenders on a sunny stone sea wall: two guards in plain grey-green tunics with spears and plain wooden round shields rimmed in iron, and a stocky gunner beside a small bronze cannon, watching three dark-sailed raider longships turn away far out at sea",
        palette="grey stone, steel, bronze, dark sails, bright sea blues",
    )),
    "award_firstLanding": dict(group="awards", ref=SCENE_REF["1024x1024"], out="awards/firstLanding.png", **spec(SCENE_COMMON, "1024x1024",
        subject="an explorer stepping from a rowing boat onto the sandy beach of an unexplored green island, planting a small pennant on a pole in the sand, a sailing ship anchored in the bay behind",
        palette="sand, turquoise shallows, fresh greens, a bright pennant",
    )),
    # ---------------------------------------------------------------- ventures
    **{f"venture_{vid}": dict(group="ventures", ref=SCENE_REF["1024x1536"], out=f"ventures/{vid}.png", **spec(
        SCENE_COMMON, "1024x1536", subject=subj, palette=f"{pal}; {GUILD_ACCENT[guild]}",
        **({"lighting": DUSK} if vid == "lighthouse" else {})))
       for guild, rows in VENTURES.items() for vid, subj, pal in rows},
    # Invasion's muster deck: four kinds of card, each played as soon as it's bought. The raiders
    # wear horned leather caps and dark furs so that they never pass for islanders.
    **{f"muster_{mid}": dict(group="muster", ref=SCENE_REF["1024x1536"], out=f"muster/{mid}.png", **spec(SCENE_COMMON, "1024x1536", subject=subj, palette=pal))
       for mid, subj, pal in [
        ("levy", "a village levy at a castle gate: a burly sergeant in a plain moss-green tabard over mail, large in the foreground, handing a spear to a young farm girl who already holds a plain wooden round shield, a cart of spears and shields beside them and a few more farmers and townsfolk waiting behind", "earthy browns, moss green, steel, pale castle stone, fresh greens"),
        ("outrider", "a lone outrider, a lean young woman with a long braid, on a fast brown horse galloping along a coastal ridge, her cloak streaming behind, a spear held upright", "chestnut horse, a dark moss-green cloak, sea blues, windswept greens"),
        ("ambush", "two island wardens in green and brown rising from behind a low drystone wall with spears levelled at a startled raider in a horned leather cap and a dark fur cloak who stumbles back with his axe raised, his beached longship's striped sail visible on the shore below", "steel, moss green and brown, dark fur, grey stone, sea blue"),
        ("turncoat", "a raider captain behind a beached longship secretly taking a small bag of coins from a cloaked islander, who points the way along the coast", "dark sail, weathered wood, grey-green cloak, gold coins, sand"),
    ]},
    # ---------------------------------------------------------- the Almanac
    # One painting per happening, square: the Almanac's card is shown small beside the roll.
    **{f"happening_{hid}": dict(group="happenings", ref=SCENE_REF["1024x1024"], out=f"happenings/{hid}.png", **spec(SCENE_COMMON, "1024x1024", subject=subj, palette=pal))
       for hid, subj, pal in [
        ("fairDay", "a peaceful island village on an ordinary fine day: washing on a line, a farmer leading a cow along a lane between cottages, fluffy clouds over the sea", "fresh greens, white washing, red roofs, sea and sky blues"),
        ("calmSeas", "a mirror-calm turquoise bay with fishing boats and a merchant ship resting by a small harbour, gulls perched on mooring posts", "turquoise, cream sails, warm stone, soft greens"),
        ("quarrel", "two burly armoured knights, one in a plain moss-green surcoat and one in a plain mustard-yellow surcoat, in a comic tug-of-war over a sack of grain in a village square, grain spilling from a split seam, while villagers laugh", "steel, moss green, mustard yellow, warm stone, greens"),
        ("quake", "a country road splitting with a jagged crack, cobbles tumbling into it, a startled cart horse rearing and dust rising from the hillside", "stone greys, earth browns, dusty ochre, fresh greens"),
        ("sickness", "a quiet town street with shuttered windows, a kindly physician in a long coat with a leather bag knocking at a door hung with drying herbs", "muted greens and greys, warm stone, herb greens"),
        ("gifts", "neighbours passing wrapped gifts and baskets over a garden fence between two cottages, flowers in the gardens and bunting overhead", "flower colours, warm thatch, festive bunting, greens"),
        ("helpingHand", "a close view of two people freeing a stuck handcart: a stout, kindly merchant woman in an ochre shawl and a white cap, large in the foreground, putting her shoulder to the back of a poor farmer's cart sunk in a muddy rut, while the thin farmer heaves at the wheel beside her, a country road and fields behind", "ochre shawl, earthy browns, mud, spring greens"),
        ("harvest", "a bountiful harvest: villagers loading a hay cart with sheaves of wheat, baskets of apples and pumpkins in a golden field", "golden wheat, apple reds, pumpkin orange, blue sky"),
        ("robberFlees", "a masked robber in a dark cloak running off down a hillside path with an empty sack while villagers with pitchforks and brooms chase him", "dark cloak, earthy browns, fresh greens"),
        ("tournament", "a close view of a joust on a green field: a mounted knight in moss green and black, large in the foreground, charging along a plain wooden tilt barrier with his lance couched, his opponent in mustard yellow and plum thundering toward him from the other end, striped pavilions and a cheering crowd behind", "steel, moss green, mustard yellow, plum, cream and green striped pavilions, fresh greens"),
        ("windfall", "a delighted young carter's lad in a straw hat and a green smock leaping to catch a heavy purse that has bounced off the back of a passing hay cart on a long country road, gold coins spilling from it into the air", "gold coins, straw, green smock, stone grey road, rolling greens"),
        ("thieves", "three hooded thieves sneaking out of a granary loft with bulging sacks while a guard dozes on a bench by the door", "charcoal hoods, warm timber, golden grain, greens"),
    ]},
    # ------------------------------------------------------------------- icons
    "icon_brick": dict(group="icons", ref=None, out="icons/brick.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small neat stack of three red clay bricks")),
    "icon_wood": dict(group="icons", ref="icon_brick", out="icons/wood.png", **spec(ICON_COMMON, "1024x1024",
        subject="a bundle of three cut logs tied with a rope")),
    "icon_wool": dict(group="icons", ref="icon_brick", out="icons/wool.png", **spec(ICON_COMMON, "1024x1024",
        subject="a fluffy round ball of cream-white wool")),
    "icon_wheat": dict(group="icons", ref="icon_brick", out="icons/wheat.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small sheaf of ripe wheat bound with straw")),
    "icon_ore": dict(group="icons", ref="icon_brick", out="icons/ore.png", **spec(ICON_COMMON, "1024x1024",
        subject="a sculpted chunk of dark slate rock with a few blue-silver ore crystals")),
    "icon_road": dict(group="uiicons2", ref="icon_brick", out="icons/road.png", **spec(ICON_COMMON, "1024x1024",
        subject="a short straight board-game road piece painted glossy brick red, a smooth rounded rectangular bar lying diagonally on a small patch of packed earth path, clearly a painted game piece and not a log or plank")),
    "icon_dice": dict(group="uiicons2", ref="icon_brick", out="icons/dice.png", **spec(ICON_COMMON, "1024x1024",
        subject="two ivory six-sided dice with rounded corners tumbling together, one with dark brown pips and one with red pips")),
    "icon_settlement": dict(group="uiicons", ref="icon_brick", out="icons/settlement.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small cosy timber-framed cottage with a pitched red tile roof, a chimney and one lit window, like a board-game settlement piece")),
    "icon_city": dict(group="uiicons", ref="icon_brick", out="icons/city.png", **spec(ICON_COMMON, "1024x1024",
        subject="a compact little stone town hall with a round tower, a conical red roof and a small flag, like a board-game city piece")),
    "icon_devcard": dict(group="uiicons", ref="icon_brick", out="icons/devcard.png", **spec(ICON_COMMON, "1024x1024",
        subject="a single face-down playing card with a deep plum back and a simple gold hexagon emblem, slightly tilted")),
    "icon_knight": dict(group="uiicons", ref="icon_brick", out="icons/knight.png", **spec(ICON_COMMON, "1024x1024",
        subject="a steel knight's helmet with a small blue plume, seen in three-quarter view")),
    "icon_route": dict(group="uiicons", ref="icon_brick", out="icons/route.png", **spec(ICON_COMMON, "1024x1024",
        subject="a wooden signpost with two arrow-shaped boards pointing in different directions on a small tuft of grass")),
    "icon_trade": dict(group="uiicons", ref="icon_brick", out="icons/trade.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small brass balance scale with two pans, one holding a red brick and the other a bundle of wheat")),
    "icon_harbour": dict(group="uiicons", ref="icon_brick", out="icons/harbour.png", **spec(ICON_COMMON, "1024x1024",
        subject="a weathered iron ship's anchor with a coil of rope")),
    "icon_vp": dict(group="uiicons", ref="icon_brick", out="icons/vp.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small golden laurel wreath")),
    "icon_cards": dict(group="uiicons", ref="icon_brick", out="icons/cards.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small fanned stack of three cream parchment playing cards seen from the back, with a teal back pattern")),
    # ---------------------------------------------------- the expansions' icons
    # The commodities and oil (cards in the hand), then the tokens the expansions count: coins,
    # fish and the Soggy Boot, wardens, prisoners, the fleet's defence token, and each guild track's
    # emblem. Each subject is one object that reads as a silhouette at 32 px.
    "icon_paper": dict(group="xicons", ref="icon_brick", out="icons/paper.png", **spec(SMALL_ICON, "1024x1024",
        # (A dark board under the light scroll gives it an edge on the parchment panels, where the
        # first try, cream sheets with a thin ribbon, was a faint smudge found only by its ribbon.)
        subject="a tightly rolled scroll of cream paper with darker tan edges, tied with a red cord, lying diagonally across a small dark walnut writing board with a rounded corner")),
    "icon_cloth": dict(group="xicons", ref="icon_brick", out="icons/cloth.png", **spec(ICON_COMMON, "1024x1024",
        subject="a neatly folded bolt of soft woven cloth in deep rose-magenta, the end loosely unrolled in a gentle fold with a small fringe")),
    "icon_silver": dict(group="xicons", ref="icon_brick", out="icons/silver.png", **spec(ICON_COMMON, "1024x1024",
        # (A first try painted plain white blocks that read as stone: the metal needs its sloped
        # ingot sides and cool reflections to say silver at 32 px.)
        subject="three small cast silver ingots, each a trapezoid bar with sloped sides, stacked two below and one on top; cool blue-grey metal catching pale sky-blue reflections on the top faces, darker steel-grey shadows on the sides, a little tarnish in the corners")),
    "icon_oil": dict(group="xicons", ref="icon_brick", out="icons/oil.png", **spec(SMALL_ICON, "1024x1024",
        # (Pale staves so the black oil is what reads: the first, dark oak barrel vanished on dark.)
        subject="a small squat barrel with pale ash-wood staves and black iron hoops, its open top brimming with glossy black oil that runs down one side in a thick drip")),
    "icon_coin": dict(group="xicons", ref="icon_brick", out="icons/coin.png", **spec(ICON_COMMON, "1024x1024",
        subject="a short stack of four worn gold coins with one more coin leaning against it, each coin stamped with a simple wave emblem")),
    "icon_fish": dict(group="xicons", ref="icon_brick", out="icons/fish.png", **spec(ICON_COMMON, "1024x1024",
        subject="a single plump fish lying on its side with its tail gently curled up, blue-green back, silver belly, small fins")),
    "icon_boot": dict(group="xicons", ref="icon_brick", out="icons/boot.png", **spec(SMALL_ICON, "1024x1024",
        subject="an old waterlogged boot whose leather the sea has faded to a light grey-tan, with darker brown seams and sole, a split toe and a frayed lace; a bright green strand of seaweed draped over its top and a small silver fish-hook caught in the lace")),
    "icon_warden": dict(group="xicons", ref="icon_brick", out="icons/warden.png", **spec(ICON_COMMON, "1024x1024",
        subject="a sturdy wooden kite shield with an iron rim and a round iron boss, painted with one plain pale band, a short spear leaning behind it")),
    "icon_prisoner": dict(group="xicons", ref="icon_brick", out="icons/prisoner.png", **spec(SMALL_ICON, "1024x1024",
        # (Grey iron reads on parchment and on wood alike; the first, brown manacles were a chain
        # scribble at 20 px.)
        subject="a single heavy iron ball and chain: a big round cannonball-like iron ball, three or four thick chain links and an open iron shackle, dark grey iron with pale steel highlights")),
    "icon_defence": dict(group="xicons", ref="icon_brick", out="icons/defence.png", **spec(ICON_COMMON, "1024x1024",
        subject="a round bronze medal stamped with a small watchtower emblem in relief, hanging from a short folded blue and white ribbon")),
    "icon_learning": dict(group="xicons", ref="icon_brick", out="icons/learning.png", **spec(ICON_COMMON, "1024x1024",
        subject="an open leather-bound book with cream pages fanned slightly, a feather quill lying across it (the pages blank, no writing)")),
    "icon_commerce": dict(group="xicons", ref="icon_brick", out="icons/commerce.png", **spec(ICON_COMMON, "1024x1024",
        subject="a plump leather merchant's purse tied at the neck with a cord, two gold coins peeking out of its mouth")),
    "icon_statecraft": dict(group="xicons", ref="icon_brick", out="icons/statecraft.png", **spec(ICON_COMMON, "1024x1024",
        subject="a small golden crown with rounded points, a red velvet cap inside and three small inset stones")),
    # The rivers' wealth tiles, as tokens beside the coins that win and lose them (the paintings
    # stay for the banner that tells the tile changing hands).
    "icon_richest": dict(group="xicons", ref="icon_brick", out="icons/richest.png", **spec(SMALL_ICON, "1024x1024",
        subject="a thick round gold medallion token with a raised rim of laurel leaves, its face stamped in relief with a small heap of coins, tilted slightly so its edge shows; bright polished gold with deep amber shadows")),
    "icon_pauper": dict(group="xicons", ref="icon_brick", out="icons/pauper.png", **spec(SMALL_ICON, "1024x1024",
        subject="a thick round token of dull dented grey tin with a plain rim, its face stamped in relief with an empty purse turned inside out, tilted slightly so its edge shows; cool grey metal with dark grey shadows and a little brown tarnish")),
    # The expansions' builds on the build bar, beside the road, settlement and city (the warden has
    # its token). Pieces like those: one object each, a game piece's simple form, readable at 34 px.
    "icon_ship": dict(group="buildicons", ref="icon_brick", out="icons/ship.png", **spec(SMALL_ICON, "1024x1024",
        subject="a small stout wooden sailing ship with one mast, a full cream square sail with a dark hem and a little red pennant, its warm brown hull riding a small curl of blue-green wave, like a board-game ship piece")),
    "icon_bridge": dict(group="buildicons", ref="icon_brick", out="icons/bridge.png", **spec(SMALL_ICON, "1024x1024",
        subject="a short single-arched bridge of warm grey stone blocks with a low parapet, spanning a narrow strip of blue river water between two small grassy banks, like a board-game bridge piece")),
    "icon_wall": dict(group="buildicons", ref="icon_brick", out="icons/wall.png", **spec(SMALL_ICON, "1024x1024",
        subject="a short gently curved section of crenellated town wall built of pale grey stone blocks with darker mortar, standing on a small tuft of grass, like a board-game wall piece")),
    "icon_foundry": dict(group="buildicons", ref="icon_brick", out="icons/foundry.png", **spec(SMALL_ICON, "1024x1024",
        subject="a small squat red-brick foundry with a slate roof, a tall square dark brick chimney with a wisp of pale grey smoke, a closed iron door and an iron anvil beside it, like a board-game foundry piece; no fire, no glow")),
    # --------------------------------------------------------------- portraits
    "avatar_1": dict(group="avatars", ref=None, out="avatars/1.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a kind old sea captain with a white beard, red knit cap and navy coat")),
    "avatar_2": dict(group="avatars", ref="avatar_1", out="avatars/2.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a confident young cartographer woman with braided auburn hair, freckles and a brass compass pendant")),
    "avatar_3": dict(group="avatars", ref="avatar_1", out="avatars/3.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a cheerful broad-shouldered blacksmith with a short dark beard and a leather apron")),
    "avatar_4": dict(group="avatars", ref="avatar_1", out="avatars/4.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a thoughtful scholar with round spectacles, silver-streaked hair tied back and a green robe")),
    # Portraits 5 to 12 are the crew's other faces, one for each name that waits for its own in
    # src/game/names.ts (CREW, the entries with `later`): painted for that name, in that order.
    # Once they are optimised into public/art/avatars/ and listed in AVATARS there, those names
    # take them. Each stays one of the four kinds of the first set (a sea trader, a settler, a
    # smith, an elder), so the crew's voices still suit them, with its own look: other ages, skin,
    # hair and dress, the same warm, kind manner.
    # avatar_5: Tomas Halvorsen
    "avatar_5": dict(group="avatars", ref="avatar_1", out="avatars/5.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a weathered ferryman in his fifties with a grey ponytail, a calm squint and laugh lines, a pale blue wool jersey under a yellow oilskin collar, a coil of rope over one shoulder")),
    # avatar_6: Ned Fairweather
    "avatar_6": dict(group="avatars", ref="avatar_1", out="avatars/6.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a jolly round-faced sailor with ginger mutton-chop whiskers, a brown peaked cap and a navy-and-cream striped jersey, a small brass spyglass tucked under one arm")),
    # avatar_7: Imani Birch
    "avatar_7": dict(group="avatars", ref="avatar_1", out="avatars/7.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a young woman surveyor with dark brown skin and short natural curls, a wide straw hat, a yellow neckerchief and a rolled map under her arm, an easy, curious smile")),
    # avatar_8: Nilufar Reed
    "avatar_8": dict(group="avatars", ref="avatar_1", out="avatars/8.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a cheerful woman in her forties with olive skin, a long black plait and an indigo headscarf, ink-stained fingers holding a small notebook, a satchel strap across her shoulder")),
    # avatar_9: Kofi Brasswright
    "avatar_9": dict(group="avatars", ref="avatar_1", out="avatars/9.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a broad, grinning brass-founder with dark brown skin, a shaved head and a short grey-flecked beard, a scorched leather apron and shirt sleeves rolled to the elbow")),
    # avatar_10: Gunnar Stokes
    "avatar_10": dict(group="avatars", ref="avatar_1", out="avatars/10.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a burly ironworker with a thick red beard braided at the end, a grey wool cap and heavy leather gloves tucked into his belt, soot on one cheek and a bashful smile")),
    # avatar_11: Rahim Thorley
    "avatar_11": dict(group="avatars", ref="avatar_1", out="avatars/11.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a dignified elderly scholar with warm brown skin and a neatly trimmed white beard, a plum-coloured cap and a long teal coat, a small reading glass hanging from a cord around his neck")),
    # avatar_12: Isidore Fenn
    "avatar_12": dict(group="avatars", ref="avatar_1", out="avatars/12.png", **spec(PORTRAIT_COMMON, "1024x1024",
        subject="a tall, thin elderly man with a bald head and white tufts over his ears, half-moon glasses, an ink-blue cardigan over a collared shirt and a quill tucked behind one ear")),
}


def render_prompt(name, a, root=OUT):
    lines = [
        f"Use case: {a['use_case']}",
        f"Asset type: {a['asset_type']}",
        f"Subject: {a['subject']}",
        f"Style/medium: {a['style']}",
        f"Composition/framing: {a.get('composition', '')}",
        f"Lighting/mood: {a['lighting']}",
    ]
    if a.get("palette"):
        lines.append(f"Color palette: {a['palette']}")
    lines.append(f"Constraints: {a['constraints']}")
    lines.append(f"Output size: {a['size']}")
    spec_text = "\n".join(lines)
    ref_note = ""
    if a.get("ref"):
        ref_note = (
            "\nInput images: Image 1 is a STYLE REFERENCE ONLY from the same card set. Match its rendering style, brushwork, "
            "lighting direction, level of detail and color temperature. Do NOT copy its subject or contents: "
            "no emblems, liveries or costume colours from it, and any people are different people from the reference image, "
            "with their own faces, clothes and colours.\n"
        )
    dest = os.path.join(root, a["out"])
    return (
        "You are producing one final production art asset. Use your built-in image generation tool exactly once to generate "
        "the image described by this spec. If the tool lets you choose a model or quality level, choose the highest-quality option available. "
        "If the spec asks for a transparent background, request a genuinely transparent background. Pass the spec through faithfully; "
        "do not add extra adjectives, quality buzzwords or lighting effects. "
        f"{ref_note}\n--- SPEC ---\n{spec_text}\n--- END SPEC ---\n\n"
        f"After generation, copy the generated PNG from $CODEX_HOME/generated_images/... to exactly this path (create folders as needed):\n{dest}\n"
        "Do not modify or create any other files. Finally print the destination path."
    ), dest


def run(name, skip_existing=False, root=OUT):
    a = ASSETS[name]
    prompt, dest = render_prompt(name, a, root)
    if skip_existing and os.path.exists(dest):
        return name, "skipped", 0
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    logs = LOGS if root == OUT else os.path.join(root, "logs")
    os.makedirs(logs, exist_ok=True)
    cmd = [CODEX, "exec", "--skip-git-repo-check", "-s", "workspace-write", "--add-dir", root, "-C", ROOT, prompt]
    if a.get("ref"):
        ref_path = os.path.join(OUT, ASSETS[a["ref"]]["out"])
        if os.path.exists(ref_path):
            # --image takes multiple values, so it must come after the positional prompt.
            cmd.append(f"--image={ref_path}")
    t0 = time.time()
    with open(os.path.join(logs, f"{name}.log"), "w") as log:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    ok = p.returncode == 0 and os.path.exists(dest)
    return name, "ok" if ok else f"FAILED (code {p.returncode})", time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--group", action="append", default=[])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("-j", type=int, default=3)
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--print-prompt", action="store_true")
    # A take goes to another folder (same layout as originals/) so it can be judged against the
    # shipped painting before it replaces it; references still come from originals/.
    ap.add_argument("--dest", default=OUT)
    args = ap.parse_args()
    if args.list:
        for k, v in ASSETS.items():
            print(f"{k:22s} {v['group']:8s} -> {v['out']}")
        return
    names = list(args.names)
    for g in args.group:
        names += [k for k, v in ASSETS.items() if v["group"] == g]
    if args.all:
        names = list(ASSETS)
    if args.print_prompt:
        for n in names:
            print(render_prompt(n, ASSETS[n])[0])
        return
    with cf.ThreadPoolExecutor(max_workers=args.j) as ex:
        dest = os.path.abspath(args.dest)
        for name, status, dt in ex.map(lambda n: run(n, args.skip_existing, dest), names):
            print(f"{name:22s} {status:20s} {dt:6.1f}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
