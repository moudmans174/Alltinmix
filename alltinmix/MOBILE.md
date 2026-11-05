# ALLTINMIX mobile app (Android and iPhone)

The phone app is your existing website packaged as a real app with **Capacitor**. It runs the same code, so everything works the same: browsing, selling, cart, payments, messages, reviews, notifications, wallet, admin. The `frontend/android` and `frontend/ios` folders are the two native projects.

What was added for the stores: a bottom tab bar on phones, safe-area handling for notches, in-app payment window (card/PayPal), Android back button, status bar and splash screen, share button, **Report** (listings, people, messages), **Block user**, **Delete my account**, **Terms** and **Privacy** pages, an admin **Reports** tab, and the `ALLOW_DIGITAL_GOODS` switch.

## Honest limits, read first

- I could not build or test the signed `.aab` / `.ipa` files or run the app on a phone here. Those steps happen on your computer with the steps below. Expect a few small first-run snags.
- **iPhone builds need a Mac** with Xcode, and an Apple Developer account (US$99/year). There is no way around this. Android builds work on Windows.
- Google Play needs a developer account (US$25 once). New personal accounts must run a **closed test with at least 12 testers for 14 days** before they can publish to production.
- Your backend must be **online with HTTPS** (for example `https://shop.yourdomain.com`) before the app can work. A phone cannot reach `localhost`.
- Real card and PayPal payments need provider keys and live testing first (see README section 4). Mobile money stays manual (admin confirms).

## 1. One-time setup

1. Deploy the website and API with Docker (README section 2). Note your address, for example `https://shop.yourdomain.com`.
2. In `backend/.env` (or the root `.env` for Docker) set:
   - `CLIENT_URL=https://shop.yourdomain.com`, `API_URL=https://shop.yourdomain.com`
   - `ALLOW_DIGITAL_GOODS=false` if you will publish on iPhone (Apple requires its own in-app purchase for digital downloads, which this app does not implement). Physical goods, services, property, vehicles are fine.
   - `SUPPORT_EMAIL` to a real inbox. Both stores and the Terms/Privacy pages show it.
3. Install on your computer: Node 22+, and **Android Studio** (Android) and/or **Xcode** (Mac only).
4. In `frontend/`, copy `.env.app.example` to `.env.app` and fill in your address:
   ```
   VITE_API_URL=https://shop.yourdomain.com/api
   VITE_WEB_URL=https://shop.yourdomain.com
   ```
5. In `frontend/`: `npm install`.

## 2. Build the app files

```
cd frontend
npm run build:app        # builds the website in app mode and copies it into android/ and ios/
```
Run this every time you change the website code. (Icons and splash come from `frontend/resources/`; change those images and run `npm run assets`.)

App id is `com.alltinmix.app` (in `capacitor.config.json`). **Choose it carefully before the first upload: it can never change.** If you want a different one, change it in `capacitor.config.json`, delete `android/` and `ios/`, then run `npx cap add android` and `npx cap add ios` again, then `npm run assets`.

## 3. Android (Google Play)

1. `npm run cap:android` opens the project in Android Studio. Let Gradle finish syncing.
2. Try it: connect a phone (USB debugging on) or start an emulator and press Run. Test sign-up, browsing, a test purchase, photo upload, back button.
3. In `android/app/build.gradle` set `versionCode` (a whole number, +1 each upload) and `versionName` (for example `1.0.0`).
4. **Build → Generate Signed Bundle / APK → Android App Bundle.** Create a new keystore, and **back it up** (file and passwords) somewhere safe. If you lose it you cannot update the app. Choose `release`.
5. Create the app in Play Console (play.google.com/console), complete the forms in section 5, upload the `.aab` to a **closed testing** track first, then promote to production.

## 4. iPhone (App Store)

1. On a Mac: install Xcode, then in `frontend/` run `npm run cap:ios`. (Capacitor 8 uses Swift Package Manager, so there is no CocoaPods step.)
2. In Xcode select the **App** target → Signing & Capabilities → choose your Team (Apple Developer account). Set the Bundle Identifier to match your app id.
3. Set Version and Build in the General tab (Build +1 each upload).
4. Run on a real iPhone to test, then **Product → Archive → Distribute App → App Store Connect**.
5. In App Store Connect (appstoreconnect.apple.com) create the app, fill in section 5, choose the build, test it with **TestFlight**, then submit for review.

## 5. Store listing checklist

**Needed for both:** app name, short and long description, 512×512 icon (use `frontend/resources/icon-only.png`), phone screenshots (take them from the running app), a privacy policy URL (`https://shop.yourdomain.com/privacy`), support email, content rating questionnaire, category (Shopping).

**Suggested text.** Short: "Buy and sell products, services, property and vehicles with protected payments." Long: say what people can do, that payments are held until delivery is confirmed, which payment methods you accept, and which country you serve.

**Google Play extras:** Data safety form (collected: name, email, phone, photos you upload, purchase history, messages; encrypted in transit; users can request deletion → say deletion is available in the app and give the web address `https://shop.yourdomain.com/account`), an account-deletion URL, target audience 18+, ads: none.

**Apple extras:** App Privacy "nutrition label" (same data as above, linked to the user, not used for tracking), a **demo account** for the reviewer (create a buyer and seller account and put the logins in "App Review Information"), and notes explaining that payments are for physical goods and services (rule 3.1.3) and that mobile-money payments are confirmed by your team.

**Rules the reviewers check, and how the app answers them**

| Rule | Where it is handled |
| --- | --- |
| Apple 3.1.1: digital goods need in-app purchase | `ALLOW_DIGITAL_GOODS=false` hides digital downloads |
| Apple 1.2 / Google UGC policy: report, block, moderate, respond quickly | Report buttons, Block, admin **Reports** tab. **You must actually review reports (aim for within 24 hours)** |
| Apple 5.1.1(v) / Google: delete account inside the app | Account → Delete my account |
| Privacy policy and terms | `/privacy`, `/terms` (starting-point text; have a lawyer adapt it to your country) |
| Apple 4.2: not just a website | Native tab bar, in-app payment window, share sheet, status bar/splash. Adding push notifications later strengthens this |

Deleting an account is refused while the user has orders in progress or money in their wallet; the app tells them what to settle first.

## 6. Updating the app later

Change the website code → `npm run build:app` → raise the version/build number → archive and upload again. Backend-only changes need no new app version.

## 7. Ideas for later

Push notifications (Firebase Cloud Messaging / Apple Push; needs `@capacitor/push-notifications` and a server sender), camera upload (`@capacitor/camera`), biometric login, Orange Money API automation, in-app purchase for digital goods.
