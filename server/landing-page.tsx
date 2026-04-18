import React from "react";

const pageStyles = `
  :root {
    --canvas: #f5efe2;
    --paper: rgba(255, 252, 246, 0.88);
    --paper-strong: #fffaf2;
    --ink: #111827;
    --muted: #5b6470;
    --line: rgba(17, 24, 39, 0.11);
    --line-strong: rgba(17, 24, 39, 0.18);
    --signal: #f26d3d;
    --signal-deep: #cb4a23;
    --signal-soft: rgba(242, 109, 61, 0.14);
    --pool: #1f7a8c;
    --pool-soft: rgba(31, 122, 140, 0.12);
    --shadow: 0 30px 80px rgba(30, 41, 59, 0.12);
    --shadow-soft: 0 18px 40px rgba(15, 23, 42, 0.08);
  }

  * {
    box-sizing: border-box;
  }

  html {
    scroll-behavior: smooth;
  }

  body {
    margin: 0;
    font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
    color: var(--ink);
    background:
      radial-gradient(circle at top left, rgba(242, 109, 61, 0.18), transparent 32%),
      radial-gradient(circle at top right, rgba(31, 122, 140, 0.16), transparent 28%),
      linear-gradient(180deg, #f9f4e8 0%, #f3ecdf 52%, #f7f3ea 100%);
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  .shell {
    position: relative;
    overflow: hidden;
    min-height: 100vh;
  }

  .shell::before,
  .shell::after {
    content: "";
    position: absolute;
    pointer-events: none;
    border-radius: 999px;
    filter: blur(18px);
  }

  .shell::before {
    top: 88px;
    right: -72px;
    width: 260px;
    height: 260px;
    background: rgba(242, 109, 61, 0.13);
  }

  .shell::after {
    left: -54px;
    bottom: 120px;
    width: 200px;
    height: 200px;
    background: rgba(31, 122, 140, 0.14);
  }

  .container {
    width: min(1180px, calc(100vw - 40px));
    margin: 0 auto;
    position: relative;
    z-index: 1;
  }

  .nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 24px 0 12px;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    font-weight: 700;
    letter-spacing: -0.03em;
    font-size: 1rem;
  }

  .brand-mark {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    color: white;
    background: linear-gradient(135deg, var(--signal) 0%, #ff9b54 100%);
    box-shadow: 0 12px 26px rgba(242, 109, 61, 0.28);
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .nav-link {
    display: inline-flex;
    align-items: center;
    min-height: 42px;
    padding: 0 16px;
    border-radius: 999px;
    border: 1px solid transparent;
    color: var(--muted);
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .nav-link:hover {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.5);
    border-color: rgba(17, 24, 39, 0.08);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.08fr) minmax(340px, 0.92fr);
    gap: 28px;
    align-items: stretch;
    padding: 28px 0 40px;
  }

  .hero-copy,
  .hero-panel,
  .section-panel,
  .feature-card,
  .story-card,
  .footer-panel {
    border: 1px solid var(--line);
    background: var(--paper);
    box-shadow: var(--shadow-soft);
    backdrop-filter: blur(18px);
  }

  .hero-copy {
    border-radius: 36px;
    padding: 42px;
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 0 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.74);
    border: 1px solid rgba(17, 24, 39, 0.08);
    color: var(--muted);
    font-size: 0.84rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .eyebrow-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--signal);
    box-shadow: 0 0 0 8px rgba(242, 109, 61, 0.12);
  }

  h1 {
    margin: 22px 0 16px;
    font-size: clamp(3rem, 7vw, 5.8rem);
    line-height: 0.94;
    letter-spacing: -0.065em;
    font-family: ui-rounded, "Avenir Next Condensed", "Avenir Next", sans-serif;
  }

  .hero-copy p {
    margin: 0;
    max-width: 34rem;
    color: var(--muted);
    font-size: 1.1rem;
    line-height: 1.75;
  }

  .cta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 28px;
  }

  .cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 54px;
    padding: 0 22px;
    border-radius: 999px;
    font-weight: 700;
    transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  }

  .cta:hover {
    transform: translateY(-1px);
  }

  .cta-primary {
    color: white;
    background: linear-gradient(135deg, var(--signal-deep) 0%, var(--signal) 100%);
    box-shadow: 0 18px 40px rgba(242, 109, 61, 0.24);
  }

  .cta-secondary {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid rgba(17, 24, 39, 0.12);
  }

  .hero-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 30px;
  }

  .stat-card {
    padding: 16px 18px;
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid rgba(17, 24, 39, 0.08);
  }

  .stat-card strong {
    display: block;
    margin-bottom: 6px;
    font-size: 1rem;
    letter-spacing: -0.03em;
  }

  .stat-card span {
    display: block;
    color: var(--muted);
    line-height: 1.5;
    font-size: 0.92rem;
  }

  .hero-panel {
    border-radius: 36px;
    padding: 24px;
    position: relative;
    overflow: hidden;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 248, 236, 0.92)),
      var(--paper);
  }

  .hero-panel::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      linear-gradient(rgba(17, 24, 39, 0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(17, 24, 39, 0.045) 1px, transparent 1px);
    background-size: 34px 34px;
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.82), transparent 88%);
    pointer-events: none;
  }

  .panel-stack {
    position: relative;
    z-index: 1;
    display: grid;
    gap: 16px;
  }

  .device-card,
  .mini-card,
  .step-card {
    border-radius: 28px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.9);
    box-shadow: var(--shadow-soft);
  }

  .device-card {
    padding: 22px;
  }

  .device-topline {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    margin-bottom: 18px;
  }

  .device-label {
    font-size: 0.84rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .device-name {
    margin-top: 6px;
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.04em;
  }

  .device-pill {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    color: var(--pool);
    background: var(--pool-soft);
    font-size: 0.84rem;
    font-weight: 700;
  }

  .transfer-list {
    display: grid;
    gap: 12px;
  }

  .transfer-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px;
    border-radius: 20px;
    background: #fffdf8;
    border: 1px solid rgba(17, 24, 39, 0.06);
  }

  .transfer-icon {
    width: 46px;
    height: 46px;
    border-radius: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--signal-soft);
    color: var(--signal-deep);
    font-size: 1.3rem;
  }

  .transfer-copy {
    flex: 1;
    min-width: 0;
  }

  .transfer-copy strong,
  .mini-card strong,
  .feature-card h3,
  .story-card h3,
  .step-card h3 {
    display: block;
    letter-spacing: -0.03em;
  }

  .transfer-copy strong {
    font-size: 0.98rem;
    margin-bottom: 4px;
  }

  .transfer-copy span,
  .mini-card span,
  .feature-card p,
  .story-card p,
  .step-card p,
  .footer-copy {
    color: var(--muted);
    line-height: 1.6;
  }

  .signal {
    font-weight: 700;
    color: var(--signal-deep);
    white-space: nowrap;
  }

  .mini-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .mini-card {
    padding: 18px;
  }

  .mini-card strong {
    font-size: 1rem;
    margin-bottom: 8px;
  }

  .sections {
    display: grid;
    gap: 22px;
    padding-bottom: 42px;
  }

  .section-panel {
    border-radius: 34px;
    padding: 32px;
  }

  .section-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 24px;
  }

  .section-kicker {
    display: block;
    margin-bottom: 10px;
    color: var(--signal-deep);
    font-size: 0.86rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .section-heading h2 {
    margin: 0;
    font-size: clamp(2rem, 4vw, 3rem);
    letter-spacing: -0.05em;
    line-height: 1;
    font-family: ui-rounded, "Avenir Next Condensed", "Avenir Next", sans-serif;
  }

  .section-heading p {
    max-width: 32rem;
    margin: 0;
    color: var(--muted);
    line-height: 1.7;
  }

  .feature-grid,
  .story-grid,
  .step-grid {
    display: grid;
    gap: 16px;
  }

  .feature-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .story-grid {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
  }

  .step-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .feature-card,
  .story-card {
    border-radius: 28px;
    padding: 24px;
  }

  .feature-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 42px;
    height: 42px;
    padding: 0 12px;
    border-radius: 14px;
    margin-bottom: 18px;
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    font-weight: 800;
  }

  .feature-card h3,
  .story-card h3,
  .step-card h3 {
    margin: 0 0 10px;
    font-size: 1.28rem;
  }

  .story-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 18px;
  }

  .story-quote {
    margin: 0;
    font-size: clamp(1.45rem, 2.4vw, 2.1rem);
    letter-spacing: -0.04em;
    line-height: 1.15;
  }

  .story-list {
    display: grid;
    gap: 10px;
  }

  .story-point {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 54px;
    padding: 0 16px;
    border-radius: 18px;
    border: 1px solid rgba(17, 24, 39, 0.08);
    background: rgba(255, 255, 255, 0.7);
    font-weight: 600;
  }

  .story-point-mark {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--signal);
    box-shadow: 0 0 0 8px rgba(242, 109, 61, 0.12);
  }

  .step-card {
    padding: 22px;
  }

  .step-number {
    width: 42px;
    height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 18px;
    border-radius: 14px;
    background: var(--ink);
    color: white;
    font-weight: 800;
  }

  .footer-panel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin: 0 0 36px;
    border-radius: 28px;
    padding: 22px 24px;
  }

  .footer-links {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }

  .footer-links a {
    color: var(--muted);
    font-weight: 600;
  }

  .footer-links a:hover {
    color: var(--ink);
  }

  @media (max-width: 960px) {
    .hero,
    .story-grid {
      grid-template-columns: 1fr;
    }

    .feature-grid,
    .step-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .hero-copy,
    .hero-panel,
    .section-panel {
      padding: 28px;
      border-radius: 28px;
    }
  }

  @media (max-width: 720px) {
    .container {
      width: min(100vw - 24px, 1180px);
    }

    .nav {
      align-items: flex-start;
      flex-direction: column;
    }

    .nav-links {
      justify-content: flex-start;
    }

    .hero-stats,
    .mini-grid,
    .feature-grid,
    .step-grid {
      grid-template-columns: 1fr;
    }

    .hero-copy,
    .hero-panel,
    .section-panel,
    .footer-panel {
      padding: 22px;
      border-radius: 24px;
    }

    h1 {
      font-size: clamp(2.6rem, 15vw, 4.2rem);
    }

    .section-heading {
      align-items: flex-start;
      flex-direction: column;
    }

    .footer-panel {
      align-items: flex-start;
      flex-direction: column;
    }
  }
`;

interface Feature {
  eyebrow: string;
  title: string;
  description: string;
}

interface Step {
  title: string;
  description: string;
}

const features: Feature[] = [
  {
    eyebrow: "LAN",
    title: "Local by default",
    description:
      "Free transfers stay on the same Wi-Fi network, so photos and videos move directly between nearby devices.",
  },
  {
    eyebrow: "LINK",
    title: "Browser downloads when you need them",
    description:
      "Premium adds hosted links with optional passcodes, so anyone can pull a file down in the browser without installing the app.",
  },
  {
    eyebrow: "ID",
    title: "Anonymous-first",
    description:
      "Start moving files without making account setup the first step. Sign in later only if you want premium restore across devices.",
  },
];

const steps: Step[] = [
  {
    title: "Open the app on two devices",
    description: "Keep both devices on the same Wi-Fi network and choose whether you want to send or receive.",
  },
  {
    title: "Pick files and confirm the nearby device",
    description:
      "The app handles discovery and transfer setup so you can approve the right target before anything moves.",
  },
  {
    title: "Finish locally or share a hosted link",
    description:
      "Stay device-to-device for quick nearby sends, or switch to a hosted browser download flow when distance matters.",
  },
];

export function LandingPage() {
  return (
    <html lang={"en"}>
      <head>
        <meta charSet={"utf-8"} />
        <meta content={"width=device-width, initial-scale=1"} name={"viewport"} />
        <title>File Transfers</title>
        <meta
          content={
            "Anonymous-first file transfers for nearby devices, with local Wi-Fi sends and premium hosted browser-download links."
          }
          name={"description"}
        />
        <meta content={"File Transfers"} property={"og:title"} />
        <meta
          content={
            "Move files directly on the same Wi-Fi network, then fall back to hosted browser links when you need wider reach."
          }
          property={"og:description"}
        />
        <meta content={"#f26d3d"} name={"theme-color"} />
        <style dangerouslySetInnerHTML={{ __html: pageStyles }} />
      </head>
      <body>
        <div className={"shell"}>
          <div className={"container"}>
            <header className={"nav"}>
              <a aria-label={"File Transfers home"} className={"brand"} href={"/"}>
                <span aria-hidden={"true"} className={"brand-mark"}>
                  FT
                </span>
                <span>File Transfers</span>
              </a>
              <nav className={"nav-links"}>
                <a className={"nav-link"} href={"#features"}>
                  Features
                </a>
                <a className={"nav-link"} href={"#how-it-works"}>
                  How it works
                </a>
                <a className={"nav-link"} href={"/privacy.txt"}>
                  Privacy
                </a>
                <a className={"nav-link"} href={"/terms.txt"}>
                  Terms
                </a>
              </nav>
            </header>

            <main>
              <section className={"hero"}>
                <div className={"hero-copy"}>
                  <div className={"eyebrow"}>
                    <span aria-hidden={"true"} className={"eyebrow-dot"} />
                    Anonymous-first file transfers
                  </div>
                  <h1>Send around the room. Share into the browser.</h1>
                  <p>
                    File Transfers keeps nearby transfers fast and simple. Move files device-to-device on the same Wi-Fi
                    network, then use hosted links and passcodes when the recipient needs a browser instead of the app.
                  </p>
                  <div className={"cta-row"}>
                    <a className={"cta cta-primary"} href={"#how-it-works"}>
                      See the flow
                    </a>
                    <a className={"cta cta-secondary"} href={"#features"}>
                      Explore features
                    </a>
                  </div>
                  <div className={"hero-stats"}>
                    <div className={"stat-card"}>
                      <strong>Nearby first</strong>
                      <span>Free transfers stay local on shared Wi-Fi.</span>
                    </div>
                    <div className={"stat-card"}>
                      <strong>Premium links</strong>
                      <span>Hosted downloads open in any browser.</span>
                    </div>
                    <div className={"stat-card"}>
                      <strong>Low setup tax</strong>
                      <span>No account required to get started.</span>
                    </div>
                  </div>
                </div>

                <div aria-label={"Product preview"} className={"hero-panel"}>
                  <div className={"panel-stack"}>
                    <section className={"device-card"}>
                      <div className={"device-topline"}>
                        <div>
                          <div className={"device-label"}>Nearby transfer</div>
                          <div className={"device-name"}>Jon&apos;s iPhone</div>
                        </div>
                        <div className={"device-pill"}>Same Wi-Fi</div>
                      </div>
                      <div className={"transfer-list"}>
                        <div className={"transfer-row"}>
                          <div aria-hidden={"true"} className={"transfer-icon"}>
                            Pi
                          </div>
                          <div className={"transfer-copy"}>
                            <strong>Beach-trip-2026.zip</strong>
                            <span>184 MB ready to move</span>
                          </div>
                          <div className={"signal"}>Direct</div>
                        </div>
                        <div className={"transfer-row"}>
                          <div aria-hidden={"true"} className={"transfer-icon"}>
                            Vid
                          </div>
                          <div className={"transfer-copy"}>
                            <strong>Interview-cut.mov</strong>
                            <span>Transfer speed adapts live</span>
                          </div>
                          <div className={"signal"}>Live</div>
                        </div>
                      </div>
                    </section>

                    <div className={"mini-grid"}>
                      <section className={"mini-card"}>
                        <strong>Hosted links</strong>
                        <span>Share a browser download page with expiration and optional passcode protection.</span>
                      </section>
                      <section className={"mini-card"}>
                        <strong>Cross-device restore</strong>
                        <span>Sign in later to bring premium access back on a new phone without re-buying.</span>
                      </section>
                    </div>
                  </div>
                </div>
              </section>

              <div className={"sections"}>
                <section className={"section-panel"} id={"features"}>
                  <div className={"section-heading"}>
                    <div>
                      <span className={"section-kicker"}>Why it feels lighter</span>
                      <h2>Built for moving files, not managing accounts.</h2>
                    </div>
                    <p>
                      The product keeps the first-run path tight: discover nearby devices, approve the right target, and
                      move the file. Premium expands the reach without changing that core transfer shape.
                    </p>
                  </div>

                  <div className={"feature-grid"}>
                    {features.map((feature) => (
                      <article className={"feature-card"} key={feature.title}>
                        <div className={"feature-badge"}>{feature.eyebrow}</div>
                        <h3>{feature.title}</h3>
                        <p>{feature.description}</p>
                      </article>
                    ))}
                  </div>
                </section>

                <section className={"section-panel"}>
                  <div className={"story-grid"}>
                    <article className={"story-card"}>
                      <div>
                        <span className={"section-kicker"}>Product shape</span>
                        <h3 className={"story-quote"}>
                          Local when the devices are close. Browser-friendly when they are not.
                        </h3>
                      </div>
                      <p>
                        File Transfers is designed for the common case first: people in the same room, on the same
                        network, needing to move a file quickly. Hosted links exist as an extension of that flow, not a
                        replacement for it.
                      </p>
                    </article>

                    <article className={"story-card"}>
                      <div className={"story-list"}>
                        <div className={"story-point"}>
                          <span aria-hidden={"true"} className={"story-point-mark"} />
                          Nearby discovery for fast handoff
                        </div>
                        <div className={"story-point"}>
                          <span aria-hidden={"true"} className={"story-point-mark"} />
                          Hosted downloads with browser access
                        </div>
                        <div className={"story-point"}>
                          <span aria-hidden={"true"} className={"story-point-mark"} />
                          Optional sign-in for premium restore
                        </div>
                      </div>
                    </article>
                  </div>
                </section>

                <section className={"section-panel"} id={"how-it-works"}>
                  <div className={"section-heading"}>
                    <div>
                      <span className={"section-kicker"}>How it works</span>
                      <h2>Three short steps.</h2>
                    </div>
                    <p>
                      The app keeps the transfer model obvious so the receiving device stays in control and the sender
                      can move quickly.
                    </p>
                  </div>

                  <div className={"step-grid"}>
                    {steps.map((step, index) => (
                      <article className={"step-card"} key={step.title}>
                        <div className={"step-number"}>{index + 1}</div>
                        <h3>{step.title}</h3>
                        <p>{step.description}</p>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            </main>

            <footer className={"footer-panel"}>
              <div>
                <strong>File Transfers</strong>
                <div className={"footer-copy"}>
                  Anonymous-first file transfers with local Wi-Fi sends and hosted browser downloads.
                </div>
              </div>
              <div className={"footer-links"}>
                <a href={"/health"}>Health</a>
                <a href={"/status"}>Status JSON</a>
                <a href={"/privacy.txt"}>Privacy</a>
                <a href={"/terms.txt"}>Terms</a>
              </div>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
