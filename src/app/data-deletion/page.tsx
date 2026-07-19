import type { Metadata } from "next";
import LegalPage from "../../components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Data Deletion Instructions | FB Multi-Page Publisher",
  description:
    "Instructions for requesting deletion of data associated with FB Multi-Page Publisher.",
};

export const dynamic = "force-static";

const headingStyle = {
  marginTop: "28px",
  marginBottom: "10px",
  fontSize: "1.35rem",
} as const;

const noticeStyle = {
  margin: "18px 0",
  padding: "16px 18px",
  borderRadius: "12px",
  background: "#eef2ff",
  border: "1px solid #c7d2fe",
} as const;

const linkStyle = {
  color: "#4f46e5",
  fontWeight: 700,
} as const;

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="Data Deletion Instructions"
      lastUpdated="July 19, 2026"
    >
      <p>
        You may request deletion of data associated with your use of FB
        Multi-Page Publisher and its Meta/Facebook integration.
      </p>

      <div style={noticeStyle}>
        Do not send passwords, Facebook access tokens, Google refresh tokens,
        application secrets, encryption keys, or other sensitive credentials
        by email.
      </div>

      <h2 style={headingStyle}>Option 1: Remove access from Facebook</h2>
      <ol>
        <li>Open Facebook Settings &amp; privacy.</li>
        <li>Open Settings.</li>
        <li>
          Find the section for Apps and Websites, Business Integrations, or
          connected applications.
        </li>
        <li>Locate FB Multi-Page Publisher or the connected Meta app.</li>
        <li>Choose Remove or Revoke Access.</li>
      </ol>
      <p>
        Removing access stops future Facebook API access. It may not
        automatically delete records already stored by the Service, so use
        Option 2 when you also want deletion from our systems.
      </p>

      <h2 style={headingStyle}>Option 2: Send a deletion request</h2>
      <p>
        Send an email from the address associated with your publisher account
        to{" "}
        <a href="mailto:zedde934@gmail.com" style={linkStyle}>
          zedde934@gmail.com
        </a>{" "}
        with the subject:
      </p>

      <p>
        <strong>Data Deletion Request - FB Multi-Page Publisher</strong>
      </p>

      <p>Include:</p>
      <ul>
        <li>your registered publisher-account email address;</li>
        <li>the name of the connected Facebook account;</li>
        <li>the names of the affected Facebook Pages;</li>
        <li>whether you want full account deletion or only Meta/Facebook data deletion; and</li>
        <li>enough information to verify that you control the account.</li>
      </ul>

      <h2 style={headingStyle}>What may be deleted</h2>
      <p>Subject to verification and legal or security requirements, deletion may include:</p>
      <ul>
        <li>stored Facebook account and Page connection records;</li>
        <li>encrypted Facebook access tokens and Page tokens;</li>
        <li>Google Drive connection records and encrypted refresh tokens;</li>
        <li>uploaded-media metadata and eligible stored media;</li>
        <li>scheduled and historical publishing records;</li>
        <li>account profile information; and</li>
        <li>other personal data associated with the account.</li>
      </ul>

      <h2 style={headingStyle}>Information we may retain</h2>
      <p>
        Limited information may be retained when reasonably necessary for
        security, fraud prevention, dispute resolution, backups, audit
        integrity, or legal compliance. Retained information will not be used
        for new publishing activity.
      </p>

      <h2 style={headingStyle}>Processing time</h2>
      <p>
        After identity and account ownership are verified, we aim to complete
        eligible deletion requests within 30 days. Complex requests, backup
        removal, legal holds, or third-party processing may require additional
        time.
      </p>

      <h2 style={headingStyle}>Confirmation</h2>
      <p>
        We will send confirmation to the verified account email when the
        deletion request has been completed or when additional information is
        required.
      </p>

      <h2 style={headingStyle}>Related policy</h2>
      <p>
        Read our{" "}
        <a href="/privacy" style={linkStyle}>
          Privacy Policy
        </a>{" "}
        for more information about data handling.
      </p>
    </LegalPage>
  );
}
