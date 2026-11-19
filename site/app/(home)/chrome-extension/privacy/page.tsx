import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { Wordmark } from "@/components/brand/Wordmark";
import { Footer } from "@/components/landing/Footer";

const title = "GeoMetrikks for Chrome privacy policy";
const description =
  "What the GeoMetrikks for Chrome extension stores on your device and sends to your own GeoMetrikks server. Nothing goes to its authors.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/chrome-extension/privacy/" },
  icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
  openGraph: { type: "website", siteName: "GeoMetrikks", title, description, url: "/chrome-extension/privacy/" },
};

export const viewport: Viewport = { themeColor: "#010810" };

// landing.css is unlayered, so Tailwind utilities lose to its section and link rules here.
const css = `
.privacy { max-width: 760px; padding: 64px 0 96px; }
.privacy h1 { font-size: clamp(28px, 3.6vw, 42px); letter-spacing: -0.025em; line-height: 1.1; font-weight: 600; margin: 0 0 12px; }
.privacy h2 { font-size: 22px; letter-spacing: -0.01em; font-weight: 600; margin: 48px 0 12px; }
.privacy p, .privacy li { color: var(--fg-dim); }
.privacy p { margin: 0 0 14px; }
.privacy ul { margin: 0 0 14px; padding-left: 22px; list-style: disc; }
.privacy li { margin: 0 0 10px; }
.privacy strong, .privacy code { color: var(--fg); }
.privacy a { color: var(--accent); text-decoration: underline; text-underline-offset: 4px; }
.privacy-header { border-bottom: 1px solid var(--line); }
.privacy-header .wrap { display: flex; align-items: center; padding-top: 20px; padding-bottom: 20px; }
.privacy-header a { display: flex; align-items: center; gap: 10px; }
`;

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <>
      <h2>{heading}</h2>
      {children}
    </>
  );
}

export default function ChromeExtensionPrivacyPage() {
  return (
    <>
      <style>{css}</style>
      <header className="privacy-header">
        <div className="wrap">
          <a href="/" aria-label="GeoMetrikks home">
            <Mark size={28} />
            <Wordmark size={18} />
          </a>
        </div>
      </header>
      <div className="wrap">
        <main className="privacy">
          <h1>GeoMetrikks for Chrome privacy policy</h1>
          <p>Last updated: 19 November 2026</p>

          <Section heading="The short version">
            <p>
              GeoMetrikks for Chrome talks to one server: the GeoMetrikks server you connect it to, which you run. It
              sends nothing to the extension&apos;s authors or to anyone else. It has no analytics, no tracking and no
              ads, and it doesn&apos;t read the pages you visit.
            </p>
          </Section>

          <Section heading="What it stores on your device">
            <p>
              The extension keeps these in Chrome&apos;s local extension storage on this computer. None of it syncs to
              other devices.
            </p>
            <ul>
              <li>
                <strong>Your server address and API key.</strong> The key is stored as you pasted it, with no encryption
                beyond what Chrome and your operating system give the browser profile. Anyone with access to your
                browser profile can read it.
              </li>
              <li>
                <strong>Your settings</strong>, such as whether &quot;Show stats for the site I&apos;m on&quot; is on.
              </li>
              <li>
                <strong>Your last five lookups</strong> on that server: each IP with its country, network and the
                CrowdSec and Spamhaus DROP marks it had at the time.
              </li>
              <li>
                <strong>Short-lived copies of server answers:</strong> AbuseIPDB results for 15 minutes, so looking at
                the same IP again doesn&apos;t spend your AbuseIPDB quota, and your server&apos;s Spamhaus DROP lists
                for 6 hours.
              </li>
              <li>
                <strong>The result of a right-click Look up or Ban</strong>, for up to 2 minutes, until the popup shows
                it. Chrome deletes it when the browser closes.
              </li>
            </ul>
          </Section>

          <Section heading="What it sends to your server">
            <p>
              Every request goes to the server address you entered, over https, with your API key in the{" "}
              <code>Authorization</code> header. The extension never sends your browser&apos;s cookies.
            </p>
            <ul>
              <li>
                <strong>The site you&apos;re on.</strong> When you click the toolbar icon on a web page and &quot;Show
                stats for the site I&apos;m on&quot; is on, the popup sends that page&apos;s host name, and its port if
                the address has one, to show the site&apos;s traffic. It sends nothing about the page itself, and
                nothing when the switch is off or when you open the popup from the right-click menu.
              </li>
              <li>
                <strong>IP addresses you look up or ban.</strong> An IP you type in the popup, or text you select on a
                page and send with Look up or Ban from the right-click menu. Selected text goes nowhere until you pick
                one of those items, and text that isn&apos;t an IP address isn&apos;t sent at all.
              </li>
              <li>
                <strong>
                  An IP you type after <code>gmk</code> in the address bar
                </strong>
                , when you press Enter. That opens the IP on your server in a tab.
              </li>
            </ul>
            <p>
              Your server, and the reverse proxy in front of it, may log these requests like any other, with the host
              names and IPs in their addresses. Those logs stay on the machines you run.
            </p>
          </Section>

          <Section heading="AbuseIPDB and other sites">
            <ul>
              <li>
                <strong>Check AbuseIPDB.</strong> When you click Check AbuseIPDB on a lookup, your server sends that IP
                to AbuseIPDB with your server&apos;s own AbuseIPDB key. The extension never contacts AbuseIPDB itself.
                AbuseIPDB&apos;s handling of that request is covered by{" "}
                <a href="https://www.abuseipdb.com/legal">its own terms and privacy policy</a>.
              </li>
              <li>
                <strong>Links you click.</strong> A lookup links to the IP&apos;s pages on CrowdSec CTI and AbuseIPDB
                and to its network on bgp.he.net. Those open in a new tab only when you click one, and that site then
                sees the IP or network number in the address, as with any link.
              </li>
            </ul>
          </Section>

          <Section heading="Permissions">
            <ul>
              <li>
                <strong>Access to your server&apos;s address</strong>, asked for when you click Connect, for that one
                address and port. The extension asks for no other site, and removes this access when you disconnect or
                switch servers.
              </li>
              <li>
                <strong>The tab you&apos;re on</strong>, when you click the toolbar icon, to read its address for site
                stats.
              </li>
              <li>
                <strong>The right-click menu</strong>, to add the GeoMetrikks items for selected text.
              </li>
              <li>
                <strong>Storage</strong>, for the items listed above.
              </li>
            </ul>
          </Section>

          <Section heading="Deleting your data">
            <ul>
              <li>Clear recent lookups on the options page deletes the lookup list.</li>
              <li>
                Disconnect on the options page deletes the key, the server address and everything kept for that server.
                Connecting a different server does the same for the old one.
              </li>
              <li>Removing the extension from Chrome deletes everything it stored.</li>
            </ul>
          </Section>

          <Section heading="Changes">
            <p>
              If what the extension stores or sends changes, this page changes with it, under a new date at the top. The
              extension&apos;s changes are listed in the <a href="/docs/reference/changelog/">GeoMetrikks changelog</a>.
            </p>
          </Section>

          <Section heading="Contact">
            <p>
              Ask privacy questions or report a problem in the{" "}
              <a href="https://github.com/GilbN/geometrikks/issues">GeoMetrikks issue tracker on GitHub</a>.{" "}
              <a href="https://geometrikks.dev/docs/features/chrome-extension/">GeoMetrikks for Chrome</a> in the docs
              explains how the extension works.
            </p>
          </Section>
        </main>
      </div>
      <Footer />
    </>
  );
}
