/**
 * MARKETPLACE CONFIG: the one file you edit to customize ALLTINMIX for a client.
 *
 * Everything here is served to the frontend through GET /api/config, so changing
 * the brand, colors, categories, or listing fields here changes the whole app.
 * Most branding values can also be overridden with environment variables so a
 * client deployment needs no code changes at all.
 *
 * Each vertical has a `commerce` kind that decides how it behaves:
 *   'product'    sold through checkout; physical (has stock) or digital (link delivered after payment)
 *   'service'    sold through checkout; has a delivery time
 *   'classified' described by custom `fields`; by default buyers contact the seller (mode 'inquiry')
 *
 * `icon` (and optional `categoryIcons`) pick icons by name; see frontend/src/icons.jsx for the names available.
 * `mode` decides the buy button: 'checkout' (cart + payment + escrow) or 'inquiry' (message the seller).
 * To add a new vertical (events, rentals, jobs...), add an entry below. No other code changes needed.
 */

const env = process.env;

// Currencies. Prices are stored and accounted in the BASE currency (CURRENCY_CODE). Buyers may also see prices and pay in the
// other currencies listed in FX_RATES, converted at a rate an admin can change in the dashboard.
// FX_RATES format: "USD:22.5,EUR:24"  =  how many base-currency units equal 1 unit of that currency.
const KNOWN_SYMBOLS = { SLE: 'Le', USD: '$', EUR: '€', GBP: '£' };
const baseCode = (env.CURRENCY_CODE || 'SLE').toUpperCase();
const fxRates = {};
for (const part of (env.FX_RATES ?? (baseCode === 'SLE' ? 'USD:22.5' : '')).split(',')) {
  const [code, rate] = part.split(':').map((x) => x.trim());
  if (code && Number(rate) > 0 && code.toUpperCase() !== baseCode) fxRates[code.toUpperCase()] = Number(rate);
}
const currencies = [baseCode, ...Object.keys(fxRates)].map((code) => ({
  code, symbol: code === baseCode ? env.CURRENCY_SYMBOL || KNOWN_SYMBOLS[code] || code : KNOWN_SYMBOLS[code] || code, decimals: 2,
}));

module.exports = {
  brand: {
    name: env.BRAND_NAME || 'ALLTINMIX',
    tagline: env.BRAND_TAGLINE || 'We bring you all your wants.',
    logoUrl: env.BRAND_LOGO_URL ?? '/logo.png', // e.g. /logo.png (file placed in frontend/public) or a full https:// link
    logoPlate: env.BRAND_LOGO_PLATE === 'true', // true: logo sits on a white badge (for logos that don't show on a dark header)
    showName: env.BRAND_SHOW_NAME !== 'false', // show the name next to the logo (set false if the logo already contains the name)
    primaryColor: env.BRAND_PRIMARY_COLOR || '#111111', // navbar, buttons
    accentColor: env.BRAND_ACCENT_COLOR || '#FEC107', // highlights, call-to-action
    supportEmail: env.SUPPORT_EMAIL || '',
  },

  currency: {
    code: baseCode, // Sierra Leonean Leone (new leone, 2022) by default
    symbol: currencies[0].symbol,
    decimals: Number(env.CURRENCY_DECIMALS || 2), // 2 for SLE/USD/EUR, 0 for currencies like JPY
  },

  fxRates, // other currencies buyers can pay in (start values; admins can change them later)
  currencies, // [{ code, symbol, decimals }], base currency first

  // Platform commission (percent) used until an admin changes it in the dashboard.
  commissionPctDefault: Number(env.DEFAULT_COMMISSION_PCT || 10),

  limits: {
    maxImagesPerListing: 8,
    maxImageMB: 5,
  },

  verticals: [
    {
      key: 'product',
      label: 'Products',
      icon: 'ShoppingBag',
      categoryIcons: { Electronics: 'Smartphone', 'Fashion & Apparel': 'Shirt', 'Home & Living': 'Sofa', 'Health & Beauty': 'Sparkles', 'Groceries & Food': 'ShoppingBasket', 'Digital Downloads': 'Download' },
      commerce: 'product',
      mode: 'checkout',
      categories: ['Electronics', 'Fashion & Apparel', 'Home & Living', 'Health & Beauty', 'Groceries & Food', 'Digital Downloads'],
      fields: [],
    },
    {
      key: 'service',
      label: 'Services',
      icon: 'Briefcase',
      categoryIcons: { 'Design & Graphics': 'Palette', 'Programming & Tech': 'Code', 'Writing & Translation': 'PenLine', 'Video & Audio': 'Clapperboard', 'Business Consulting': 'BriefcaseBusiness', 'Home Services': 'House', 'Repairs & Maintenance': 'Wrench' },
      commerce: 'service',
      mode: 'checkout',
      categories: ['Design & Graphics', 'Programming & Tech', 'Writing & Translation', 'Video & Audio', 'Business Consulting', 'Home Services', 'Repairs & Maintenance'],
      fields: [],
    },
    {
      key: 'property',
      label: 'Real Estate',
      icon: 'Building2',
      categoryIcons: { Houses: 'House', Apartments: 'Building2', 'Land & Plots': 'Mountain', 'Commercial & Offices': 'Store' },
      commerce: 'classified',
      mode: 'inquiry',
      categories: ['Houses', 'Apartments', 'Land & Plots', 'Commercial & Offices'],
      fields: [
        { key: 'listingFor', label: 'Listing for', type: 'select', options: ['For sale', 'For rent'], required: true },
        { key: 'propertyType', label: 'Property type', type: 'select', options: ['House', 'Apartment', 'Land', 'Commercial', 'Office'], required: true },
        { key: 'bedrooms', label: 'Bedrooms', suffix: ' bd', type: 'number', min: 0, max: 50 },
        { key: 'bathrooms', label: 'Bathrooms', suffix: ' ba', type: 'number', min: 0, max: 50 },
        { key: 'areaSqm', label: 'Area (m²)', suffix: ' m²', type: 'number', min: 1, max: 10000000 },
        { key: 'furnished', label: 'Furnished', type: 'select', options: ['Yes', 'No', 'Partly'] },
      ],
    },
    {
      key: 'vehicle',
      label: 'Vehicles',
      icon: 'Car',
      categoryIcons: { Cars: 'Car', Motorcycles: 'Bike', 'Trucks & Vans': 'Truck', 'Boats & Other': 'Sailboat' },
      commerce: 'classified',
      mode: 'inquiry',
      categories: ['Cars', 'Motorcycles', 'Trucks & Vans', 'Boats & Other'],
      fields: [
        { key: 'make', label: 'Make', type: 'text', required: true },
        { key: 'model', label: 'Model', type: 'text', required: true },
        { key: 'year', label: 'Year', type: 'number', min: 1950, max: 2100, required: true },
        { key: 'mileageKm', label: 'Mileage (km)', suffix: ' km', type: 'number', min: 0, max: 5000000 },
        { key: 'fuel', label: 'Fuel', type: 'select', options: ['Petrol', 'Diesel', 'Hybrid', 'Electric', 'Other'] },
        { key: 'transmission', label: 'Transmission', type: 'select', options: ['Manual', 'Automatic'] },
        { key: 'condition', label: 'Condition', type: 'select', options: ['New', 'Used'] },
      ],
    },
  ],
};
