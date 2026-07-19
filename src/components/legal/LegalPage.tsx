import type { ReactNode } from "react";
import Link from "next/link";

type LegalPageProps = {
  title: string;
  lastUpdated: string;
  children: ReactNode;
};

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f7fb",
    color: "#171923",
    padding: "48px 20px",
  },
  card: {
    width: "100%",
    maxWidth: "920px",
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "18px",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
    padding: "40px",
  },
  backLink: {
    display: "inline-block",
    marginBottom: "24px",
    color: "#4f46e5",
    fontWeight: 700,
    textDecoration: "none",
  },
  title: {
    margin: 0,
    fontSize: "clamp(2rem, 4vw, 3rem)",
    lineHeight: 1.15,
    letterSpacing: "-0.03em",
  },
  updated: {
    marginTop: "10px",
    color: "#64748b",
    fontSize: "0.95rem",
  },
  divider: {
    border: 0,
    borderTop: "1px solid #e5e7eb",
    margin: "28px 0",
  },
  content: {
    fontSize: "1rem",
    lineHeight: 1.75,
  },
  footer: {
    marginTop: "40px",
    paddingTop: "24px",
    borderTop: "1px solid #e5e7eb",
    color: "#64748b",
    fontSize: "0.92rem",
  },
} as const;

export default function LegalPage({
  title,
  lastUpdated,
  children,
}: LegalPageProps) {
  return (
    <main style={styles.page}>
      <article style={styles.card}>
        <Link href="/" style={styles.backLink}>
          ← Back to FB Multi-Page Publisher
        </Link>

        <header>
          <h1 style={styles.title}>{title}</h1>
          <p style={styles.updated}>Last updated: {lastUpdated}</p>
        </header>

        <hr style={styles.divider} />

        <div style={styles.content}>{children}</div>

        <footer style={styles.footer}>
          FB Multi-Page Publisher · staudtmaxturtle.com
        </footer>
      </article>
    </main>
  );
}
