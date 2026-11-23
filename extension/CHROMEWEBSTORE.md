# Chrome Web Store listing: GeoMetrikks for Chrome

> Last updated: 2026-11-20

What goes into the Chrome Developer Dashboard for each upload. The zip comes from `bun run ext:build && bun run ext:check-dist && bun run ext:zip`, or from the GitHub release, which carries `geometrikks-chrome-<version>.zip`. This file is not in the zip.

## Store listing

**Extension name**

GeoMetrikks for Chrome

Same as `name` in `manifest.json`.

**Short description** (132 characters at most)

Look up and ban IPs and see the current site's traffic on your own GeoMetrikks server, from the toolbar or right-click menu.

Same as `description` in `manifest.json`.

**Detailed description**

The store shows plain text, so paste this as it stands:

```text
Look up an IP address, ban it through CrowdSec, and see how the site you're on is doing, all from your own GeoMetrikks server.

GeoMetrikks is a self-hosted dashboard for your reverse proxy's access logs. This extension needs a GeoMetrikks server of your own, reached over https, and an API key from it.

WHAT IT DOES
• Look up an IP from the toolbar, from text you select on any page (right-click > GeoMetrikks > Look up), or by typing gmk and the IP in the address bar.
• See where the IP is, its network, its requests to your sites in the last 24 hours or 7 days, the paths it asked for, and any CrowdSec decision, Spamhaus DROP listing or AbuseIPDB score.
• Ban an IP for 1 hour, 4 hours, 24 hours, 7 days or for good, from the lookup or straight from the right-click menu. Unban it from the lookup.
• Open the toolbar popup on one of your own sites to see that site's requests, unique IPs, error rate, bytes served, a chart, and its top countries, paths and IPs.
• Follows your key: a Read key gives a read-only popup with no Ban buttons. A Read/write key can ban and unban when your server has CrowdSec bans set up.
• Follows your system's light or dark mode.

HOW TO USE
1. In GeoMetrikks, open Settings > API keys and create a key.
2. Open the extension's options, enter your server's https:// address and the key, and click Connect. A server with authentication off connects with the key field empty. If a key was saved for that server, disconnect first.
3. Click the toolbar icon, select an IP on a page and right-click it, or type gmk in the address bar.

PRIVACY
The extension talks only to the GeoMetrikks server you connect it to. Nothing goes to the extension's authors. Your key, settings and last five lookups are stored on this device, and the key is sent to your server only if you connected with one. The site you're on is sent to your server only when you open the popup and "Show stats for the site I'm on" is on. Selected text is sent only when you pick Look up or Ban.

PERMISSIONS
• Access to your GeoMetrikks server: asked for when you click Connect, for that one address only. The extension asks for no other site.
• The site you're on: read when you click the toolbar icon, to show that site's stats.
• Right-click menu: adds the GeoMetrikks items for selected text.
• Storage: keeps your server address, key, settings and recent lookups on this device.

SUPPORT
Docs: https://geometrikks.dev/docs/features/chrome-extension
Bugs and ideas: https://github.com/GilbN/geometrikks/issues
```

**Category**

Developer Tools

**Single purpose**

Look up and ban IPs and see traffic for your own sites from your GeoMetrikks server.

**Primary language**

English

## Graphics and assets

| Asset | Size | Status | File |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG, 96×96 artwork with 16 px transparent padding | Ready | `extension/store/store-icon-128.png` |
| Screenshot 1: site stats | 1280×800 | Ready | `extension/store/screenshot-1-site-stats.png` |
| Screenshot 2: IP lookup | 1280×800 | Ready | `extension/store/screenshot-2-ip-lookup.png` |
| Screenshot 3: right-click menu | 1280×800 | Ready | `extension/store/screenshot-3-right-click.png` |
| Screenshot 4: options page, connected | 1280×800 | Ready | `extension/store/screenshot-4-options.png` |
| Small promo tile | 440×280 | Ready | `extension/store/promo-small-440x280.png` |
| Marquee promo tile | 1400×560 | Ready | `extension/store/promo-marquee-1400x560.png` |

### Screenshot notes

To make them again, start `scripts/extension-e2e-server.sh`, source the `keys.env` it prints, and run `bun run ext:store`. That captures the popup and options page live and lays them out in `extension/store/`. To change a caption or the layout later, edit `extension/scripts/store/compose.mjs` and run `bun run ext:store:compose`, which reuses the last run's captures. The screen numbers below are the screens on the mockup board.

1. Screen 2. The popup on one of your own sites with traffic: the 24 hour view, the chart, the Countries tab.
2. Screen 4. A lookup with a CrowdSec ban badge and a DROP badge. The IP is `203.0.113.42` on a made-up network, so no real address appears banned. The extension hides the AbuseIPDB check for that documentation range, so this shot has no AbuseIPDB score.
3. Screen 7. The right-click menu on a selected IP with the Ban submenu open. Headless Chrome can't capture its own menus, so this menu is HTML drawn with the extension's real items.
4. Screen 1. The options page with the Connected card showing the key name, scope and features.

## Permissions justification

| Permission | Type | Justification |
| --- | --- | --- |
| `storage` | permissions | Keeps the user's GeoMetrikks server address, the API key if the user connected with one, the "Show stats for the site I'm on" setting and the last five IP lookups on the device. Also keeps the last AbuseIPDB result for each IP, reused for up to 15 minutes so a second look at the same IP doesn't spend the user's daily AbuseIPDB quota again, and the server's Spamhaus DROP lists, reused for up to 6 hours. Those copies are removed on Disconnect, when the user switches servers, or when a newer answer overwrites them. Anything the extension was still saving for the old server at that moment can land afterwards. The extension never uses it again, and the next Disconnect or server switch removes it. A right-click Look up or Ban keeps the selected text and its result in session storage for up to 2 minutes, until the popup shows it. Nothing is synced. |
| `contextMenus` | permissions | Adds a GeoMetrikks item to the right-click menu for selected text, with "Look up" and "Ban" for the selected IP address. Ban has a submenu with the five ban lengths. With a Read key, or a server without CrowdSec bans, only Look up is added. With no server connected nothing is added. |
| `activeTab` | permissions | When the user clicks the toolbar icon, the popup reads the address of the tab they are on, so it can show that site's traffic from the user's GeoMetrikks server. Only the host name, and its port if the address has one, is used and sent, only to the user's own server, and only while the "Show stats for the site I'm on" switch is on. The extension doesn't read page content and asks for no access to other tabs. |
| `https://*/*` | optional_host_permissions | The user's GeoMetrikks server can be at any https address, often on their own network. When the user clicks Connect, the extension asks for access to that one origin with its port (for example `https://geo.example.net:443/*`), and it calls only that server's API. Nothing is granted at install. On Disconnect, or when the user connects a different server, the extension removes the access it was given. |

The address bar keyword (`omnibox`, keyword `gmk`) is a manifest entry, not a permission. Typing `gmk` and an IP suggests opening it in the GeoMetrikks IP inspector and lists a matching recent lookup.

Remote code: none. All code, fonts, flag images and icons are in the package. The extension fetches JSON from the user's server only.

## Privacy and data use

### Data collection

**Does the extension collect user data?** Yes, in the store's sense: it handles the three types below. All of it goes only to the GeoMetrikks server the user connects, which the user runs. The extension's authors receive nothing.

| Data type | Handled? | Leaves the device? | Purpose | Shared with third parties? |
| --- | --- | --- | --- | --- |
| Personally identifiable info | No | | | |
| Health info | No | | | |
| Financial and payment info | No | | | |
| Authentication info | Yes | Sent only to the user's own server, as the `Authorization` header, and only when the user connected with a key | The user's GeoMetrikks API key, stored on the device, proves the user to their server. A server with authentication off is connected without one | No |
| Personal communications | No | | | |
| Location | No | | | |
| Web history | Yes | Sent only to the user's own server | The host name of the tab the user is on, sent when the user opens the popup with "Show stats for the site I'm on" on, to show that site's traffic | No |
| User activity | No | | | |
| Website content | Yes | Sent only to the user's own server | Text the user selects and sends with Look up or Ban, to look up or ban that IP. The text and its result stay in session storage for up to 2 minutes, until the popup shows them | No |

### Data use certification

- [x] Data is not sold to third parties.
- [x] Data is not used or transferred for purposes unrelated to the extension's single purpose.
- [x] Data is not used or transferred to determine creditworthiness or for lending.

## Privacy policy

**Privacy policy URL**

https://geometrikks.dev/chrome-extension/privacy

Check that it loads before each submission. Its content must match the table above.

## Distribution

**Visibility:** Unlisted until GeoMetrikks 0.26.0 is released, since site stats need it. Then switch to Public.

**Regions:** All regions

## Developer info

**Publisher name:** GilbN

**Contact email:** extension@geometrikks.dev, a Cloudflare Email Routing alias on geometrikks.dev that forwards to the maintainer. The store shows it publicly on the listing, so never put a personal address here. Takedown and policy mail goes to the developer account's own email, which stays private.

**Trader status:** Non-Trader. A Trader also has a verified name, address and phone number published.

**Support URL:** https://github.com/GilbN/geometrikks/issues

**Homepage URL:** https://geometrikks.dev/docs/features/chrome-extension

## Submission checklist

- [ ] The zip is the one attached to the GitHub release, or a fresh one from `bun run ext:build && bun run ext:check-dist && bun run ext:zip`.
- [ ] `version` in `extension/manifest.json` is higher than the published one.
- [ ] https://geometrikks.dev/chrome-extension/privacy loads and matches the data table above.
- [ ] The screenshots and promo tiles in `extension/store/` are uploaded.
- [ ] The dashboard's test instructions hold the text under "Test instructions" below.
- [ ] Once the listing exists, add its Chrome Web Store URL to this file, and change the install line in `site/content/docs/next/features/chrome-extension.mdx` to link it.

## Version history

| Version | Date | Changes | Status |
| --- | --- | --- | --- |
| 0.1.0 | 2026-11-19 | First release: IP lookup from the popup, the right-click menu and the `gmk` keyword; ban and unban through CrowdSec; site stats for the tab's host; read-only mode for Read keys. | Draft |

Every upload needs a higher `version` in `extension/manifest.json` than the published one.

## Edge Add-ons (later)

Edge users install the extension from the Chrome Web Store for now. A listing on Edge Add-ons is a separate submission through Microsoft Partner Center, made later:

- The same zip works. Edge reads the same manifest and permissions.
- Partner Center asks for its own listing text, screenshots and privacy policy URL. The copy and the privacy page above can be reused, but the store description should say Edge where it says Chrome.
- The extension name says "for Chrome". Decide before submitting whether Edge gets the same name.
- Edge and Chrome versions can move separately, but keeping them equal avoids two version histories.

## Review notes

### Known limits

- The extension needs the user's own GeoMetrikks server over https. It refuses http addresses, local ones included.
- Site stats need GeoMetrikks 0.26.0 or later. On older servers the popup says so, and lookups and bans still work.
- Servers that log in nginx's `combined` format record no host, so they have no site stats.
- The reviewer has no GeoMetrikks server to test against. The test instructions say so and point to the install docs. If a review is rejected because the reviewer couldn't test it, the fix is a public demo server with a Read/write key and bans going to a test CrowdSec.

### Test instructions

The Additional instructions field takes 500 characters at most. Leave Username and Password empty, since the extension uses an API key and never logs in.

```text
Client for GeoMetrikks, a self-hosted access log dashboard. It works only with a server the user runs, so there is no shared account.

Without a server, Options shows the connect form and the popup asks to connect. Nothing is sent until a server is connected.

To test: run a server from https://geometrikks.dev/docs, create a key under Settings > API keys, then enter the https address and key in Options and click Connect.

The screenshots show the connected popup.
```

### Rejection history

None yet.
