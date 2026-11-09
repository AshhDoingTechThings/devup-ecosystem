import { logger } from "../middleware/logger";
import { assertPublicWebUrl, type Resolver } from "./publicUrl";

/**
 * HTML → PDF using headless Chrome.
 *
 * The HR templates are already print-styled HTML with @page rules, so rendering
 * them through a real browser gives output identical to what a person would get
 * from Ctrl+P — which matters, because candidates print these and show them to
 * colleges.
 *
 * Chromium is heavy and may be unavailable in some deployments, so every failure
 * path degrades to "no PDF" rather than breaking document issuance. The document
 * record and its HTML are always saved either way.
 */

type Browser = { newPage: () => Promise<any>; close: () => Promise<void> };

let browserPromise: Promise<Browser | null> | null = null;
let unavailableReason: string | null = null;
let unavailableAt = 0;

/**
 * How long a launch failure is trusted before trying again.
 *
 * Without this, one failure disables PDFs for the life of the process — a
 * transient out-of-memory at boot would silently turn every offer letter into
 * an HTML-only record until someone happened to restart the server.
 */
const RETRY_AFTER_MS = 5 * 60_000;

/**
 * May the renderer fetch this URL?
 *
 * Letters embed image URLs that a startup's admins type into their branding
 * (logo, signature, co-signature, mark). Chrome runs on this server, so
 * without a check, a "logo" of http://169.254.169.254/... or an internal
 * hostname made the server request it on every render. Only inline data and
 * public web addresses are loaded; everything else (file:, internal hosts,
 * private ranges, odd ports) is refused, which the letter shows as a missing
 * image.
 */
export async function rendererMayFetch(url: string, resolve?: Resolver): Promise<boolean> {
  if (url.startsWith("data:")) return true;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    await assertPublicWebUrl(url, resolve);
    return true;
  } catch {
    return false;
  }
}

async function getBrowser(): Promise<Browser | null> {
  if (unavailableReason && Date.now() - unavailableAt < RETRY_AFTER_MS)
    return null;
  if (unavailableReason) {
    // Cooldown elapsed — clear the latch and try once more.
    unavailableReason = null;
    browserPromise = null;
  }
  if (browserPromise) return browserPromise;

  browserPromise = (async () => {
    try {
      const puppeteer = (await import("puppeteer")).default as any;
      const browser = (await puppeteer.launch({
        headless: true,
        // Hosts that ship their own Chrome (Render, Docker images, Nix) set this
        // rather than relying on puppeteer's bundled download.
        ...(process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}),
        // Required in containers; dev-shm is tiny there and Chrome will crash.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--font-render-hinting=none",
        ],
      })) as Browser & { on?: (e: string, fn: () => void) => void };

      /*
       * If Chromium dies — out of memory on a small host is the usual cause —
       * drop the handle. Before this, the dead browser stayed cached for the
       * life of the process, every later render failed on newPage(), and every
       * offer letter went out with no PDF attached until somebody restarted
       * the server.
       */
      browser.on?.("disconnected", () => {
        logger.warn("PDF browser disconnected — it will be relaunched on the next render");
        browserPromise = null;
      });
      return browser;
    } catch (err) {
      unavailableReason = (err as Error).message;
      unavailableAt = Date.now();
      logger.error(
        `PDF rendering unavailable — offer letters will be issued WITHOUT a PDF ` +
          `and without an email attachment. Install Chrome on this host ` +
          `(build step: npx puppeteer browsers install chrome). Cause: ${unavailableReason}`,
      );
      return null;
    }
  })();

  return browserPromise;
}

export function isPdfAvailable() {
  return unavailableReason === null;
}

export function pdfUnavailableReason() {
  return unavailableReason;
}

export interface PdfOptions {
  /** A4 for letters, or a custom size for ID cards. */
  width?: string;
  height?: string;
  landscape?: boolean;
  /**
   * Letterhead that repeats on every page.
   *
   * Chrome renders these outside the page body, which is the only way to get a
   * header on page four of a document nobody has written yet. They are plain
   * HTML with their own inline styles — no stylesheet from the document
   * reaches them — and images must be data URIs, since a relative or
   * unreachable URL simply renders as blank space.
   */
  headerHtml?: string;
  footerHtml?: string;
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
}

/**
 * Renders a PDF, retrying once on a fresh browser.
 *
 * A render that fails because the browser crashed between two letters is not
 * a reason to email a candidate an offer with nothing attached. The second
 * attempt relaunches Chromium; only if that fails too does the caller get null.
 */
export async function htmlToPdf(
  html: string,
  opts: PdfOptions = {},
): Promise<Buffer | null> {
  const first = await renderOnce(html, opts);
  if (first) return first;

  logger.warn("PDF render failed — relaunching the browser and retrying once");
  await closePdfBrowser().catch(() => undefined);
  return renderOnce(html, opts);
}

async function renderOnce(
  html: string,
  opts: PdfOptions,
): Promise<Buffer | null> {
  const browser = await getBrowser();
  if (!browser) return null;

  let page: any;
  try {
    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (request: any) => {
      const url: string = request.url();
      rendererMayFetch(url).then(
        (allowed) => {
          if (allowed) return request.continue();
          logger.warn(`PDF render blocked a request to ${url.slice(0, 120)}`);
          return request.abort("blockedbyclient");
        },
        () => request.abort("blockedbyclient"),
      ).catch(() => undefined); // the page may already be closed
    });

    // waitUntil networkidle0 so remote logos and signature images are painted
    // before the snapshot; without it letters can render with missing branding.
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });

    const running = Boolean(opts.headerHtml || opts.footerHtml);

    const pdf = await page.pdf({
      ...(opts.width && opts.height
        ? { width: opts.width, height: opts.height }
        : { format: "A4" }),
      landscape: opts.landscape ?? false,
      printBackground: true,
      // A running header needs Chrome's own margin box; honouring the page's
      // @page size instead would leave nowhere to draw it.
      preferCSSPageSize: !running,
      ...(running
        ? {
            displayHeaderFooter: true,
            headerTemplate: opts.headerHtml ?? "<span></span>",
            footerTemplate: opts.footerHtml ?? "<span></span>",
          }
        : {}),
      margin: running
        ? {
            top: opts.margin?.top ?? "38mm",
            bottom: opts.margin?.bottom ?? "26mm",
            left: opts.margin?.left ?? "18mm",
            right: opts.margin?.right ?? "18mm",
          }
        : { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
    });

    return Buffer.from(pdf);
  } catch (err) {
    logger.error(`PDF render failed: ${(err as Error).message}`);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Frees Chromium on shutdown so the process can exit cleanly. */
export async function closePdfBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  if (b) await b.close().catch(() => {});
  browserPromise = null;
}
