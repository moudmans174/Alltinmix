import React from 'react';
import { Link } from 'react-router-dom';
import { useConfig } from '../context';

/**
 * Starting-point legal pages. They use your brand name and support email. Have a lawyer review and adapt them to
 * your country before you publish the app; Apple and Google both require a working Privacy Policy link.
 */
function Page({ title, children }) {
  return (
    <div className="container page legal"><div className="card">
      <h1>{title}</h1>
      <p className="muted small">Last updated: {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</p>
      {children}
    </div></div>
  );
}

export function Privacy() {
  const { brand } = useConfig();
  const mail = brand.supportEmail ? <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a> : 'the marketplace owner';
  return (
    <Page title="Privacy Policy">
      <p>{brand.name} ("we", "us") runs this marketplace. This page explains what personal information we collect and how we use it.</p>
      <h3>What we collect</h3>
      <ul>
        <li><b>Account details:</b> your name, email address, phone number (optional), password (stored only as a one-way hash) and, for sellers, payout details.</li>
        <li><b>Marketplace activity:</b> listings, photos you upload, orders, payments, messages, reviews and reports.</li>
        <li><b>Payment information:</b> card and PayPal payments are handled by our payment providers, and we do not store card numbers. For mobile money we keep the phone number and transaction ID you give us.</li>
        <li><b>Technical data:</b> basic logs such as IP address and device type, used to keep the service secure.</li>
      </ul>
      <h3>How we use it</h3>
      <p>To run your account, process orders and payments, hold and release money through escrow, let buyers and sellers contact each other, send receipts and service notifications, prevent fraud and abuse, and meet legal obligations. We do not sell your personal information.</p>
      <h3>Who sees it</h3>
      <p>Buyers and sellers see each other's name and the details needed to complete an order. Payment providers and email services process data for us under their own terms. We may share information when the law requires it.</p>
      <h3>Your choices</h3>
      <ul>
        <li>You can edit your profile any time in <Link to="/account">Account</Link>.</li>
        <li>You can delete your account in <Link to="/account">Account</Link> → Delete my account. Your personal details are removed or anonymised and your listings are taken down. Records of completed orders and payments are kept where needed for accounting and legal reasons.</li>
        <li>You can block other users and report listings, people or messages.</li>
      </ul>
      <h3>Keeping data safe and how long we keep it</h3>
      <p>We use encryption in transit, hashed passwords and access controls. We keep data while your account is active and as long as the law requires afterwards.</p>
      <h3>Children</h3>
      <p>{brand.name} is not meant for children under 18, and we do not knowingly collect their data.</p>
      <h3>Contact</h3>
      <p>Questions or requests about your data: {mail}.</p>
    </Page>
  );
}

export function Terms() {
  const { brand, commissionPct } = useConfig();
  const mail = brand.supportEmail ? <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a> : 'the marketplace owner';
  return (
    <Page title="Terms of Use">
      <p>By using {brand.name} you agree to these terms.</p>
      <h3>Your account</h3>
      <p>You must be 18 or older and give accurate information. Keep your password private. You are responsible for what happens under your account.</p>
      <h3>Buying and selling</h3>
      <ul>
        <li>Sellers are responsible for their listings, prices, descriptions, and for delivering what they sell.</li>
        <li>Payments are held by {brand.name} until the buyer confirms the order is as described (or it is automatically confirmed after the review period). A platform fee of {commissionPct}% is deducted from the seller's earnings.</li>
        <li>If something goes wrong, a buyer can open a dispute and our team will decide whether to release or refund the payment.</li>
        <li>With cash on delivery, the buyer pays the seller in cash when the item is handed over, and the seller owes the platform fee to {brand.name}. Delivery fees go to the seller. Pickup and delivery details are shared between the buyer and seller only.</li>
        <li>Mobile money payments are confirmed manually and may take time. Refunds and withdrawals are processed by our team.</li>
      </ul>
      <h3>What is not allowed</h3>
      <p>Illegal, counterfeit, stolen or dangerous items, fraud, harassment, hateful or sexual content involving minors or non-consenting people, spam, and attempts to take deals or payments outside the platform to avoid its protections.</p>
      <h3>Reporting and moderation</h3>
      <p>You can report any listing, user or message from the app and block users you do not want to hear from. We review reports and may remove content or suspend accounts that break these terms, normally within 24 hours.</p>
      <h3>Liability</h3>
      <p>{brand.name} provides the platform and escrow service. We are not a party to the sale between buyer and seller. To the extent allowed by law we are not liable for losses caused by sellers, buyers, or events outside our control.</p>
      <h3>Changes and contact</h3>
      <p>We may update these terms and will post the new version here. Questions: {mail}.</p>
    </Page>
  );
}
