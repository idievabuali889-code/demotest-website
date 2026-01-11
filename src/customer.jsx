const { useState, useEffect, useRef, useMemo, useLayoutEffect } = React;

    // ---- Types (JSDoc for clarity) ----
    /** @typedef {
      "All" |
      "Phone Screens" |
      "Back Glass" |
      "Power Banks" |
      "Screen Protectors" |
      "Batteries" |
      "Mobile Phones" |
      "Tablets" |
      "Phone Cases" |
      "Cables" |
      "Chargers" |
      "Earphones" |
      "Charging Ports" |
      "Face ID"
    } Category */

  /** @typedef {{
   *  id: string,
   *  name: string,
   *  sku: string,
   *  category: Category,
   *  price: number,
   *  minOrder?: number,
   *  image?: string,
   *  images?: string[],   //  support multiple images
   *  specs: string[],
   *  description: string,
  *  variants?: Record<string, string[]>,
  *  // Add these to support owner overrides/hiding
  *  sourceId?: string,     // if this is an owner override of a base product
  *  hidden?: boolean,      // if true (and sourceId is set), hide base product
   *  inventory?: Record<string, number>,
   * }} Product
   */

    // ---- Constants ----
    const BRAND_NAME = "Odil Accessories";
    const TAGLINE = "Simple wholesale catalogue with WhatsApp ordering.";
    const CURRENCY = "GBP";
    const CURRENCY_SYMBOL = "£";
    const WHATSAPP_NUMBER_E164 = "992935563306";
    const CART_STORAGE_KEY = "nova_wholesale_cart_v1";
    const OWNER_STORAGE_KEY = "nova_owner_products_v1";
    const OWNER_PORTAL_ONLY = document.body.dataset.layout === 'owner';
    const OWNER_ACCESS_ENABLED = OWNER_PORTAL_ONLY || document.body.dataset.ownerMode !== 'disabled';
    const OWNER_TOGGLE_ENABLED = OWNER_ACCESS_ENABLED && !OWNER_PORTAL_ONLY;
    const DEFAULT_OWNER_MODE = OWNER_PORTAL_ONLY || document.body.dataset.defaultOwner === 'true';
    const OWNER_API_ENDPOINT = '/.netlify/functions/catalogue';
    const INVENTORY_BASE_KEY = '__base__';
    const CONFIG_PRODUCT_ID = '__catalog_config__';
    const META_SPEC_PREFIX = '__';
    const META_FAMILY_PREFIX = '__family:';
    const PRICE_OVERRIDE_VARIANTS_KEY = '__prices';

    const stripMetaSpecs = (specs) =>
      (Array.isArray(specs) ? specs : []).filter((s) => {
        const value = String(s || '');
        return value && !value.startsWith(META_SPEC_PREFIX);
      });

    const buildVariantOptionSet = (variants) => {
      const set = new Set();
      if (!variants || typeof variants !== 'object') return set;
      Object.values(variants).forEach((raw) => {
        if (!Array.isArray(raw)) return;
        raw.forEach((value) => {
          const normalized = String(value || '').trim().toLowerCase();
          if (normalized) set.add(normalized);
        });
      });
      return set;
    };

    const filterSpecsForDisplay = (specs, variants) => {
      const optionSet = buildVariantOptionSet(variants);
      return stripMetaSpecs(specs).filter((s) => !optionSet.has(String(s || '').trim().toLowerCase()));
    };

    const splitLabeledSpec = (spec) => {
      const value = String(spec || '').trim();
      const idx = value.indexOf(':');
      if (idx <= 0) return null;
      const label = value.slice(0, idx).trim();
      const detail = value.slice(idx + 1).trim();
      if (!label || !detail) return null;
      if (label.length > 40 || detail.length > 120) return null;
      return { label, detail };
    };

    const extractFamilyFromProduct = (product) => {
      const specs = Array.isArray(product?.specs) ? product.specs : [];
      const match = specs.find((s) => typeof s === 'string' && s.startsWith(META_FAMILY_PREFIX));
      return match ? String(match).slice(META_FAMILY_PREFIX.length).trim() : '';
    };

    const inferFamilyFromProduct = (product) => {
      const variants = product?.variants && typeof product.variants === 'object' ? product.variants : {};
      const modelOptions = Array.isArray(variants.Model) ? variants.Model : [];
      const joined = modelOptions.map((m) => String(m || '').toLowerCase());
      if (joined.some((m) => m.startsWith('iphone'))) return 'iPhone';
      if (joined.some((m) => m.startsWith('galaxy a'))) return 'Samsung A';
      if (joined.some((m) => m.startsWith('galaxy s'))) return 'Samsung S';
      return 'Accessories';
    };

    const getProductFamily = (product) => {
      const explicit = extractFamilyFromProduct(product);
      if (explicit) return explicit;
      return inferFamilyFromProduct(product);
    };

    const buildVariantKey = (selection = {}) => {
      const entries = Object.entries(selection || {}).filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== '');
      if (!entries.length) return INVENTORY_BASE_KEY;
      return entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dimension, value]) => `${dimension}:${value}`)
        .join('|');
    };

    const normalizeInventoryObject = (raw) => {
      if (!raw || typeof raw !== 'object') return {};
      const result = {};
      Object.entries(raw).forEach(([key, value]) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) {
          result[(key && key.trim()) || INVENTORY_BASE_KEY] = numeric;
        }
      });
      return result;
    };

    const normalizePriceOverrides = (raw) => {
      if (!raw || typeof raw !== 'object') return {};
      const result = {};
      Object.entries(raw).forEach(([key, value]) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) {
          result[(key && key.trim()) || INVENTORY_BASE_KEY] = numeric;
        }
      });
      return result;
    };

    const getProductPriceMap = (product) =>
      normalizePriceOverrides(product?.variants?.[PRICE_OVERRIDE_VARIANTS_KEY]);

    const getUnitPriceForKey = (product, key) => {
      const base = Number(product?.price) || 0;
      const map = getProductPriceMap(product);
      const normalizedKey = (key && String(key).trim()) || INVENTORY_BASE_KEY;
      if (Object.prototype.hasOwnProperty.call(map, normalizedKey)) return map[normalizedKey];
      return base;
    };

    const getProductPriceRange = (product) => {
      const base = Number(product?.price) || 0;
      const map = getProductPriceMap(product);
      const values = Object.values(map);
      if (!values.length) return { min: base, max: base, hasOverrides: false };
      const min = Math.min(base, ...values);
      const max = Math.max(base, ...values);
      return { min, max, hasOverrides: min !== max };
    };

    // ---- Supabase Configuration ----
    const PUBLIC_SUPABASE_CONFIG = window.SUPABASE_PUBLIC_CONFIG || {};
    const SUPABASE_URL = PUBLIC_SUPABASE_CONFIG.url || '';
    const SUPABASE_ANON_KEY = PUBLIC_SUPABASE_CONFIG.anonKey || '';
    const SUPABASE_CONFIG_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
    
    // Initialize Supabase client
    let supabase = null;
    try {
      if (window.supabase && SUPABASE_CONFIG_READY) {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log('✅ Supabase client initialized successfully');
        console.log('📍 Supabase URL:', SUPABASE_URL);
        
        // Comprehensive connection test
        const testConnection = async () => {
          try {
            console.log('🔄 Testing database connection...');
            
            // Test 1: Basic select
            const { data: testData, error: testError } = await supabase
              .from('products')
              .select('count')
              .limit(1);
            
            if (testError) {
              console.error('❌ Database test failed:', testError);
              if (testError.message.includes('permission denied')) {
                console.error('🚫 RLS Policy Issue: Run the SQL script to fix permissions');
              }
              if (testError.message.includes('relation "products" does not exist')) {
                console.error('🏗️ Table Missing: Run the SQL script to create the products table');
              }
            } else {
              console.log('✅ Database connection successful');
            }
            
            // Test 2: Check realtime capability
            console.log('🔄 Testing realtime connection...');
            const channel = supabase.channel('test-channel');
            channel.subscribe((status) => {
              if (status === 'SUBSCRIBED') {
                console.log('✅ Realtime connection successful');
                channel.unsubscribe();
              } else if (status === 'CHANNEL_ERROR') {
                console.error('❌ Realtime connection failed');
              }
            });
            
          } catch (error) {
            console.error('❌ Connection test failed:', error);
          }
        };
        
        // Run test after a short delay
        setTimeout(testConnection, 1000);
        
      } else {
        console.warn('⚠️ Supabase not initialized - supply SUPABASE_PUBLIC_CONFIG in supabase-config.js');
      }
    } catch (error) {
      console.error('❌ Supabase initialization failed:', error);
    }

    // Utility function for retrying failed operations
    const retryOperation = async (operation, maxRetries = 3, delay = 1000) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          console.warn(`⚠️ Attempt ${attempt}/${maxRetries} failed:`, error.message);
          if (attempt === maxRetries) throw error;
          await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
      }
    };

    const getOwnerAuthHeader = async () => {
      try {
        if (!supabase) return null;
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        return token ? `Bearer ${token}` : null;
      } catch {
        return null;
      }
    };

    const callOwnerApi = async (action, payload) => {
      try {
        const authHeader = await getOwnerAuthHeader();
        const response = await fetch(OWNER_API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify({ action, data: payload }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Owner API ${action} failed: ${response.status} ${text}`);
        }
        const json = await response.json().catch(() => ({}));
        if (json?.error) {
          const err = new Error(json.error.message || json.error);
          err.details = json.error.details;
          err.hint = json.error.hint;
          err.code = json.error.code;
          throw err;
        }
        return json;
      } catch (error) {
        console.error(`Owner API ${action} error`, error);
        throw error;
      }
    };

    const normalizeProductRow = (row) => {
      if (!row) return null;
      const {
        sourceid,
        sourceId: existingSourceId,
        images,
        image,
        specs,
        variants,
        inventory,
        price,
        hidden,
        ...rest
      } = row;
      const sourceId = existingSourceId ?? sourceid ?? null;
      const toArray = (val) => {
        if (Array.isArray(val)) return val;
        if (val == null) return [];
        if (typeof val === 'string' && val.trim().length) return [val];
        return [];
      };
      const normalizedImages = toArray(images);
      const normalizedSpecs = toArray(specs);
      const normalizedVariants = (() => {
        if (typeof variants === 'object' && variants !== null && !Array.isArray(variants)) {
          return variants;
        }
        return {};
      })();
      const normalizedInventory = normalizeInventoryObject(inventory);
      const primaryImage = image || normalizedImages[0] || undefined;
      const finalImages = normalizedImages.length ? normalizedImages : (primaryImage ? [primaryImage] : []);
      return {
        ...rest,
        sourceId,
        images: finalImages,
        specs: normalizedSpecs,
        variants: normalizedVariants,
        inventory: normalizedInventory,
        price: typeof price === 'number' ? price : Number(price) || 0,
        hidden: Boolean(hidden),
        image: primaryImage,
      };
    };

    const prepareProductForDatabase = (product) => {
      const payload = {
        id: product.id,
        name: product.name,
        sku: product.sku,
        category: product.category,
        price: Number(product.price) || 0,
        description: product.description ?? '',
      };
      const images = Array.isArray(product.images)
        ? product.images
        : (product.image ? [product.image] : []);
      // Always include these fields so edits can CLEAR them (empty array/object)
      payload.images = images;
      payload.specs = Array.isArray(product.specs) ? product.specs : [];
      payload.variants = (product.variants && typeof product.variants === 'object' && !Array.isArray(product.variants))
        ? product.variants
        : {};
      if (product.sourceId) payload.sourceid = product.sourceId;
      if (product.hidden) payload.hidden = true;
      const normalizedInventory = normalizeInventoryObject(product.inventory);
      payload.inventory = normalizedInventory;
      return payload;
    };

    // ---- Database Functions ----
    const loadProductsFromDatabase = async () => {
      if (!supabase) {
        console.warn('⚠️ Cannot load products: Supabase not initialized');
        return [];
      }
      try {
        console.log('🔄 Loading products from database...');
        const { data, error } = await supabase
          .from('products')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) {
          console.error('❌ Database error:', error);
          throw error;
        }

        console.log(`✅ Loaded ${data?.length || 0} products from database`);

        // map DB -> app shape
        return (data || []).map(normalizeProductRow).filter(Boolean);
      } catch (error) {
        console.error('Failed to load products:', error);
        return [];
      }
    };

    const saveProductToDatabase = async (product) => {
      try {
        const payload = prepareProductForDatabase(product);
        const { data: inserted } = await retryOperation(() => callOwnerApi('insert', payload));
        const normalized = normalizeProductRow(inserted);
        console.log('✅ Product saved successfully:', normalized);
        return normalized;
      } catch (error) {
        console.error('❌ Failed to save product after retries:', error);
        return null;
      }
    };

    const upsertProductToDatabase = async (product) => {
      try {
        const payload = prepareProductForDatabase(product);
        const { data: upserted } = await retryOperation(() => callOwnerApi('upsert', payload));
        return normalizeProductRow(upserted);
      } catch (error) {
        console.error('Failed to upsert product:', error);
        return null;
      }
    };

    const deleteProductFromDatabase = async (productId) => {
      try {
        await retryOperation(() => callOwnerApi('delete', { id: productId }));
        return true;
      } catch (error) {
        console.error('Failed to delete product:', error);
        return false;
      }
    };

    // Real-time subscription for product updates
    const subscribeToProductChanges = (callback) => {
      if (!supabase) return null;
      try {
        const subscription = supabase
          .channel('products')
          .on('postgres_changes', 
            { event: '*', schema: 'public', table: 'products' },
            callback
          )
          .subscribe();
        
        return subscription;
      } catch (error) {
        console.error('Failed to subscribe to product changes:', error);
        return null;
      }
    };

    const CATEGORIES = [
      "All",
      "Phone Screens",
      "Back Glass",
      "Power Banks",
      "Screen Protectors",
      "Batteries",
      "Mobile Phones",
      "Tablets",
      "Phone Cases",
      "Cables",
      "Chargers",
      "Earphones",
      "Charging Ports",
      "Face ID",
    ];

    // --- Shared option lists (unified) ---
    // Models
    const IPHONE_MODELS = [
      "iPhone 11","iPhone 12","iPhone 12 Pro","iPhone 13","iPhone 13 Pro","iPhone 14","iPhone 14 Pro",
      "iPhone 15","iPhone 15 Plus","iPhone 15 Pro","iPhone 15 Pro Max","iPhone 16","iPhone 16 Pro","iPhone 16 Pro Max",
    ];
    const GALAXY_MODELS = ["Galaxy S20","Galaxy S21","Galaxy S22","Galaxy S23","Galaxy S24","Galaxy S25"];
    const ALL_PHONE_MODELS = [...IPHONE_MODELS, ...GALAXY_MODELS];

    // ── Brand buckets for the Owner form (brand → model list)
    const SAMSUNG_S_MODELS = ["Galaxy S20","Galaxy S21","Galaxy S22","Galaxy S23","Galaxy S24","Galaxy S25"];
    const SAMSUNG_A_MODELS = ["Galaxy A14","Galaxy A24","Galaxy A34","Galaxy A54","Galaxy A55","Galaxy A15"]; // edit to your real A-series list

    const PHONE_BRANDS = ["iPhone","Samsung S","Samsung A"];
    const BRAND_MODELS = {
      "iPhone": IPHONE_MODELS,
      "Samsung S": SAMSUNG_S_MODELS,
      "Samsung A": SAMSUNG_A_MODELS
    };

    const buildDefaultCatalogConfig = () => ({
      version: 1,
      categories: CATEGORIES.filter((c) => c !== 'All'),
      families: [
        { id: 'iphone', name: 'iPhone', models: [...IPHONE_MODELS] },
        { id: 'samsung_s', name: 'Samsung S', models: [...SAMSUNG_S_MODELS] },
        { id: 'samsung_a', name: 'Samsung A', models: [...SAMSUNG_A_MODELS] },
        { id: 'accessories', name: 'Accessories', models: [] },
      ],
      groupsByCategory: {},
      groupOverridesByCategoryFamily: {},
      groupHiddenByCategoryFamily: {},
    });

    const mergeCatalogConfig = (raw) => {
      const base = buildDefaultCatalogConfig();
      if (!raw || typeof raw !== 'object') return base;
      const next = { ...base, ...raw };
      next.categories = Array.isArray(next.categories) ? next.categories.filter(Boolean) : base.categories;
      next.families = Array.isArray(next.families) ? next.families.filter(Boolean) : base.families;
      next.groupsByCategory = next.groupsByCategory && typeof next.groupsByCategory === 'object' ? next.groupsByCategory : {};
      next.groupOverridesByCategoryFamily = next.groupOverridesByCategoryFamily && typeof next.groupOverridesByCategoryFamily === 'object' ? next.groupOverridesByCategoryFamily : {};
      next.groupHiddenByCategoryFamily = next.groupHiddenByCategoryFamily && typeof next.groupHiddenByCategoryFamily === 'object' ? next.groupHiddenByCategoryFamily : {};
      return next;
    };

    function useCatalogConfig(ownerProducts) {
      const [catalogConfig, setCatalogConfig] = useState(() => buildDefaultCatalogConfig());

      useEffect(() => {
        const configRow = (ownerProducts || []).find((p) => p && p.id === CONFIG_PRODUCT_ID);
        const raw = configRow?.variants?.__config;
        if (raw && typeof raw === 'object') {
          setCatalogConfig(mergeCatalogConfig(raw));
        }
      }, [ownerProducts]);

      return catalogConfig;
    }

    // Common lists
    const QUALITY_GRADE = ["Original","OEM","AAA","Aftermarket","Refurb"];
    const CASE_MATERIALS = ["TPU","Silicone","PC","Leather"];
    const CASE_COLORS = ["Black","White","Navy","Clear","Red","Lavender","Stone","Midnight","Starlight","Blue","Green","Gold"];
    // Visual swatch for color names used in chips/selectors
    const COLOR_SWATCH = {
      Black: "#111827",
      White: "#ffffff",
      Navy: "#1e3a8a",
      Clear: "#ffffff",
      Red: "#ef4444",
      Lavender: "#b57edc",
      Stone: "#a8a29e",
      Midnight: "#0f172a",
      Starlight: "#f8fafc",
      Blue: "#3b82f6",
      Green: "#10b981",
      Gold: "#f59e0b",
    };

    function ColorDot({ name }) {
      const hex = COLOR_SWATCH[name];
      const style = hex
        ? { backgroundColor: hex, border: "1px solid rgba(0,0,0,.15)" }
        : {
            backgroundImage:
              "linear-gradient(45deg,#e5e7eb 25%,transparent 25%)," +
              "linear-gradient(-45deg,#e5e7eb 25%,transparent 25%)," +
              "linear-gradient(45deg,transparent 75%,#e5e7eb 75%)," +
              "linear-gradient(-45deg,transparent 75%,#e5e7eb 75%)",
            backgroundSize: "8px 8px",
            border: "1px solid rgba(0,0,0,.15)",
          };
      return React.createElement('span', {
        'aria-hidden': 'true',
        className: 'inline-block h-3 w-3 rounded-full align-[-2px]',
        style,
      });
    }
    const PROTECTOR_MATERIALS = ["Tempered","Hydrogel"];
    const PROTECTOR_FINISH = ["Clear","Matte","Privacy"];
    const PROTECTOR_PACKS = ["1-Pack","2-Pack"];
    const COVERAGE = ["Edge-to-edge","Full glue"];
    const CONNECTORS = ["USB-C ↔ USB-C","USB-C ↔ Lightning","USB-A ↔ Micro-USB"];
    const LENGTHS = ["0.5m","1m","2m"];
    const POWER_RATINGS = ["27W","60W","100W"];
    const CERTS = ["MFi","USB-IF"];
    const DURABILITY = ["Standard","Braided",">10k bends"];
    const CHARGER_WATTAGE = ["20W","30W","45W","65W"];
    const CHARGER_PORTS = ["1×USB-C","1×USB-A","1×USB-C + 1×USB-A","2×USB-C"];
    const STANDARDS = ["PD 3.0","PPS","QC 3.0","QC 4+"];
    const SAFETY = ["CE","UKCA"];
    const PLUG_TYPES = ["UK 3-pin","EU","US"];
    const PHONE_GRADE = ["New","Refurb","Used A","Used B"];
    const SIM_OPTIONS = ["Unlocked","Locked","Dual-SIM Yes","Dual-SIM No"];
    const CONN_MOBILE = ["5G","4G"];
    const CONNECTIVITY_TABLET = ["Wi-Fi","Wi-Fi + Cellular"];

  const STORAGE_OPTIONS = ["32GB","64GB","128GB","256GB","512GB","1TB"];
  const RAM_OPTIONS = ["3GB","4GB","6GB","8GB","12GB","16GB"];

    // Backwards-compatible aliases for existing variable names used elsewhere in the file
    const CABLE_CONNECTORS = CONNECTORS;
    const CABLE_LENGTHS = LENGTHS;
    const CABLE_RATINGS = POWER_RATINGS;
    const POWER_CAPACITY = ["10,000 mAh","20,000 mAh"];

    // ---- Small base catalogue (~12 items) ----
    /** @type {Product[]} */
    const CATALOG = [
      {
        id: "sp-iph-13-tmp-2pk",
        name: "Tempered Glass – iPhone 13 (2‑Pack)",
        sku: "SP-IP13-TG2",
        category: "Screen Protectors",
        price: 3.2,
        specs: ["2‑Pack", "Tempered", "9H", "Oleophobic"],
        description: "Clear tempered glass for iPhone 13.",
  image: "Изображение WhatsApp 2025-08-16 в 15.37.07_b6d5696d.jpg",
        variants: { Model: ["iPhone 13"], Material: ["Tempered"], Pack: ["2‑Pack"] },
      },
      {
        id: "sp-iph-14-hg-1pk",
        name: "Hydrogel Protector – iPhone 14",
        sku: "SP-IP14-HG1",
        category: "Screen Protectors",
        price: 2.6,
        specs: ["Hydrogel", "Self‑healing", "Case‑friendly"],
        description: "Flexible hydrogel film.",
  image: "Изображение WhatsApp 2025-08-16 в 15.37.08_46a12f36.jpg",
        variants: { Model: ["iPhone 14"], Material: ["Hydrogel"], Pack: ["1‑Pack","2‑Pack"] },
      },
      {
        id: "case-slim-tpu-iph-11-16",
        name: "Slim TPU Case – iPhone Series",
        sku: "CA-IP-TPU",
        category: "Phone Cases",
        price: 3.9,
        specs: ["TPU", "Slim", "Matte"],
        description: "Slim matte TPU case.",
  image: "Изображение WhatsApp 2025-08-16 в 15.37.09_811264ed.jpg",
        variants: { Color: ["Black","Navy","Clear","Red"], Material: ["TPU"], Model: IPHONE_MODELS },
      },
      {
        id: "case-silicone-sg-s20-s25",
        name: "Soft Silicone Case – Galaxy Series",
        sku: "CA-SG-SIL",
        category: "Phone Cases",
        price: 4.1,
        specs: ["Silicone", "Microfiber"],
        description: "Soft‑touch silicone for Galaxy.",
  image: "Изображение WhatsApp 2025-08-16 в 15.37.10_3d78676b.jpg",
        variants: { Color: ["Midnight","Stone","Lavender"], Material: ["Silicone"], Model: GALAXY_MODELS },
      },
  { id: "chg-65w-gan-dual", name: "65W GaN Charger – Dual Port", sku: "CH-65W-GAN", category: "Chargers", price: 12.5, specs: ["65W","USB‑C + USB‑A","PD/QC"], description: "Compact GaN charger.", image: "Изображение WhatsApp 2025-08-16 в 15.37.11_89070b32.jpg", variants: { Wattage: ["65W"], Ports: ["USB‑C + USB‑A"], Standard: STANDARDS } },
  { id: "chg-20w-usbc", name: "20W USB‑C Wall Charger", sku: "CH-20W-USBC", category: "Chargers", price: 6.0, specs: ["20W","USB‑C","PD"], description: "USB‑C PD charger.", image: "Изображение WhatsApp 2025-08-16 в 15.37.11_9ebc1ea2.jpg", variants: { Wattage: ["20W"], Ports: ["USB‑C"], Standard: ["PD 3.0"] } },
  { id: "cbl-usbc-60w-1m-2m", name: "USB‑C Cable 60W", sku: "CB-UC-60", category: "Cables", price: 2.2, specs: ["USB‑C","60W","Nylon"], description: "Braided 60W cable.", image: "Изображение WhatsApp 2025-08-16 в 15.37.12_628fcab2.jpg", variants: { Connector: ["USB‑C ↔ USB‑C"], Length: CABLE_LENGTHS, Rating: ["60W"] } },
  { id: "cbl-lightning-mfi", name: "Lightning Cable (MFi)", sku: "CB-LT-MFI", category: "Cables", price: 3.5, specs: ["Lightning","MFi","1m"], description: "MFi Lightning cable.", image: "Изображение WhatsApp 2025-08-16 в 15.37.13_22d8e7c9.jpg", variants: { Connector: ["USB‑C ↔ Lightning"], Length: ["1m"], Rating: ["27W"] } },
  { id: "ear-wired-classic", name: "Wired Earphones – Classic", sku: "EA-WI-CLS", category: "Earphones", price: 4.2, specs: ["3.5mm","In‑line mic"], description: "Wired earphones.", image: "Изображение WhatsApp 2025-08-16 в 15.37.14_4f407f9a.jpg", variants: { Connector: ["3.5mm"], Color: ["Black","White"] } },
  { id: "ear-tws-basic", name: "TWS Earbuds – Basic", sku: "EA-TWS-BSC", category: "Earphones", price: 12.9, specs: ["BT 5.3","20h"], description: "TWS earbuds.", image: "Изображение WhatsApp 2025-08-16 в 15.37.15_e7b8adc0.jpg", variants: { Color: ["White","Black"], Standard: ["BT 5.3"] } },
  { id: "pb-10000-compact", name: "Power Bank 10,000 mAh", sku: "PB-10K-CMP", category: "Power Banks", price: 11.0, specs: ["10,000 mAh","USB‑C","PD"], description: "Slim 10k power bank.", image: "Изображение WhatsApp 2025-08-16 в 15.37.17_01d0dcae.jpg", variants: { Capacity: ["10,000 mAh"], Ports: ["USB‑C","USB‑A"], Standard: STANDARDS } },
  { id: "pb-20000-dual", name: "Power Bank 20,000 mAh – Dual", sku: "PB-20K-DUAL", category: "Power Banks", price: 16.5, specs: ["20,000 mAh","Dual","PD/QC"], description: "20k dual output.", image: "Изображение WhatsApp 2025-08-16 в 15.37.19_3b58c17b.jpg", variants: { Capacity: ["20,000 mAh"], Ports: ["USB‑C + USB‑A"], Standard: STANDARDS } },

      // --- Auto-added from img/ folder (randomised simple entries) ---
      { id: 'img-001', name: 'Accessory Photo A', sku: 'IM-001', category: 'Phone Cases', price: 2.5, specs: ['Assorted'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.33_5dd08e33.jpg' },
      { id: 'img-002', name: 'Accessory Photo B', sku: 'IM-002', category: 'Chargers', price: 7.2, specs: ['Fast'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.34_09a1e9d9.jpg' },
      { id: 'img-003', name: 'Accessory Photo C', sku: 'IM-003', category: 'Cables', price: 1.8, specs: ['1m'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.34_f1935767.jpg' },
      { id: 'img-004', name: 'Accessory Photo D', sku: 'IM-004', category: 'Screen Protectors', price: 2.9, specs: ['Tempered'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.35_92866963.jpg' },
      { id: 'img-005', name: 'Accessory Photo E', sku: 'IM-005', category: 'Phone Cases', price: 3.6, specs: ['TPU'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.36_d9ee268e.jpg' },
      { id: 'img-006', name: 'Accessory Photo F', sku: 'IM-006', category: 'Back Glass', price: 5.5, specs: ['Glass'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.37_ef5ed98e.jpg' },
      { id: 'img-007', name: 'Accessory Photo G', sku: 'IM-007', category: 'Earphones', price: 6.0, specs: ['Wireless'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.38_b444897c.jpg' },
      { id: 'img-008', name: 'Accessory Photo H', sku: 'IM-008', category: 'Power Banks', price: 9.9, specs: ['10k'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.38_f170faf6.jpg' },
      { id: 'img-009', name: 'Accessory Photo I', sku: 'IM-009', category: 'Cables', price: 2.0, specs: ['2m'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.39_c37cddc9.jpg' },
      { id: 'img-010', name: 'Accessory Photo J', sku: 'IM-010', category: 'Chargers', price: 11.5, specs: ['65W'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.40_7a858ba3.jpg' },
      { id: 'img-011', name: 'Accessory Photo K', sku: 'IM-011', category: 'Phone Cases', price: 4.4, specs: ['Silicone'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.41_80d08b54.jpg' },
      { id: 'img-012', name: 'Accessory Photo L', sku: 'IM-012', category: 'Screen Protectors', price: 1.9, specs: ['Hydrogel'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.41_a2efd2e1.jpg' },
      { id: 'img-013', name: 'Accessory Photo M', sku: 'IM-013', category: 'Back Glass', price: 6.5, specs: ['Back glass'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.42_63c16e8a.jpg' },
      { id: 'img-014', name: 'Accessory Photo N', sku: 'IM-014', category: 'Batteries', price: 8.0, specs: ['OEM'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.43_06e00e31.jpg' },
      { id: 'img-015', name: 'Accessory Photo O', sku: 'IM-015', category: 'Phone Cases', price: 3.2, specs: ['Clear'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.44_de3a612b.jpg' },
      { id: 'img-016', name: 'Accessory Photo P', sku: 'IM-016', category: 'Cables', price: 2.4, specs: ['Nylon'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.44_fddf905d.jpg' },
      { id: 'img-017', name: 'Accessory Photo Q', sku: 'IM-017', category: 'Earphones', price: 5.0, specs: ['Wired'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.45_b1dd7f8a.jpg' },
      { id: 'img-018', name: 'Accessory Photo R', sku: 'IM-018', category: 'Chargers', price: 9.5, specs: ['30W'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.46_30024620.jpg' },
      { id: 'img-019', name: 'Accessory Photo S', sku: 'IM-019', category: 'Power Banks', price: 14.0, specs: ['20k'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.46_cb602f30.jpg' },
      { id: 'img-020', name: 'Accessory Photo T', sku: 'IM-020', category: 'Phone Cases', price: 3.8, specs: ['Leather'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.46_d9e5908c.jpg' },
      { id: 'img-021', name: 'Accessory Photo U', sku: 'IM-021', category: 'Screen Protectors', price: 2.7, specs: ['Matte'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.47_ac758901.jpg' },
      { id: 'img-022', name: 'Accessory Photo V', sku: 'IM-022', category: 'Cables', price: 1.6, specs: ['0.5m'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.48_bc4af4ef.jpg' },
      { id: 'img-023', name: 'Accessory Photo W', sku: 'IM-023', category: 'Chargers', price: 4.9, specs: ['USB‑A'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.48_f4496fba.jpg' },
      { id: 'img-024', name: 'Accessory Photo X', sku: 'IM-024', category: 'Earphones', price: 13.5, specs: ['TWS'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.49_ad6d3003.jpg' },
      { id: 'img-025', name: 'Accessory Photo Y', sku: 'IM-025', category: 'Phone Cases', price: 2.9, specs: ['Clear'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.50_b3694795.jpg' },
      { id: 'img-026', name: 'Accessory Photo Z', sku: 'IM-026', category: 'Back Glass', price: 7.0, specs: ['Glass'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.51_5e67178c.jpg' },
      { id: 'img-027', name: 'Accessory Photo AA', sku: 'IM-027', category: 'Batteries', price: 6.9, specs: ['Refurb'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.52_df23fdba.jpg' },
      { id: 'img-028', name: 'Accessory Photo AB', sku: 'IM-028', category: 'Chargers', price: 8.5, specs: ['PD'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.53_13d347f3.jpg' },
      { id: 'img-029', name: 'Accessory Photo AC', sku: 'IM-029', category: 'Cables', price: 2.1, specs: ['Braided'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.54_5c3d1851.jpg' },
      { id: 'img-030', name: 'Accessory Photo AD', sku: 'IM-030', category: 'Power Banks', price: 12.2, specs: ['Dual output'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.54_8f092381.jpg' },
      { id: 'img-031', name: 'Accessory Photo AE', sku: 'IM-031', category: 'Earphones', price: 3.9, specs: ['Wired'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.56_cbdfea17.jpg' },
      { id: 'img-032', name: 'Accessory Photo AF', sku: 'IM-032', category: 'Phone Cases', price: 4.5, specs: ['Patterned'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.57_61b6ae02.jpg' },
      { id: 'img-033', name: 'Accessory Photo AG', sku: 'IM-033', category: 'Screen Protectors', price: 2.3, specs: ['Clear'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.57_efd60a9b.jpg' },
      { id: 'img-034', name: 'Accessory Photo AH', sku: 'IM-034', category: 'Chargers', price: 10.0, specs: ['GaN'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.36.58_082b158d.jpg' },
      { id: 'img-035', name: 'Accessory Photo AI', sku: 'IM-035', category: 'Power Banks', price: 15.0, specs: ['High capacity'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.37.00_7e6451d4.jpg' },
      { id: 'img-036', name: 'Accessory Photo AJ', sku: 'IM-036', category: 'Cables', price: 1.5, specs: ['USB-C'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.37.01_bf466384.jpg' },
      { id: 'img-037', name: 'Accessory Photo AK', sku: 'IM-037', category: 'Earphones', price: 7.5, specs: ['TWS'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.37.03_2920cb02.jpg' },
      { id: 'img-038', name: 'Accessory Photo AL', sku: 'IM-038', category: 'Phone Cases', price: 3.1, specs: ['Transparent'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.37.03_2ae9f56f.jpg' },
      { id: 'img-039', name: 'Accessory Photo AM', sku: 'IM-039', category: 'Back Glass', price: 6.8, specs: ['OEM'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.37.03_725a57bf.jpg' },
      { id: 'img-040', name: 'Accessory Photo AN', sku: 'IM-040', category: 'Chargers', price: 5.5, specs: ['USB-A'], description: 'Sample product using real photo', image: 'Изображение WhatsApp 2025-08-16 в 15.37.04_faa6a5d9.jpg' }
    ];

    // ---- Utilities ----
    const fmt = (n) => new Intl.NumberFormat("en-GB", { style: "currency", currency: CURRENCY }).format(n);
    const cx = (...c) => c.filter(Boolean).join(" ");

    function usePrefersReducedMotion(){
      const [reduced, setReduced] = useState(false);
      useEffect(()=>{ const mq = window.matchMedia("(prefers-reduced-motion: reduce)"); setReduced(mq.matches); const h=()=>setReduced(mq.matches); mq.addEventListener?.("change", h); return ()=> mq.removeEventListener?.("change", h); },[]);
      return reduced;
    }

    function buildPlaceholderDataURI(label) {
      const bg = encodeURIComponent("#f3f4f6");
      const fg = encodeURIComponent("#6b7280");
      const text = encodeURIComponent(label);
      const svg = `<?xml version='1.0' encoding='UTF-8'?><svg xmlns='http://www.w3.org/2000/svg' width='800' height='600' role='img' aria-label='${text}'><rect width='100%' height='100%' fill='${bg}'/><g fill='${fg}' font-family='system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif'><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='24'>${text}</text></g></svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    function resolveImageSrc(image, name){
      if(!image) return buildPlaceholderDataURI(name);
      if(image.startsWith('data:') || image.startsWith('http')) return image;
      return `/img/${image}`;
    }

    // Helpers to surface product images and a primary image
    function getProductImages(product){
      const list = Array.isArray(product.images) && product.images.length ? product.images
                : (product.image ? [product.image] : []);
      return list.length ? list : [buildPlaceholderDataURI(product.name)];
    }
    function getPrimaryImage(product){
      const imgs = getProductImages(product);
      return resolveImageSrc(imgs[0], product.name);
    }

    function useFocusTrap(active, ref, onEscape){
      const escapeRef = useRef(onEscape);
      useEffect(() => {
        escapeRef.current = onEscape;
      }, [onEscape]);
      useEffect(()=>{
        if(!active || !ref.current) return;
        const root = ref.current;
        const qs = [
          'a[href]','button:not([disabled])','textarea:not([disabled])','input:not([disabled])','select:not([disabled])','[tabindex]:not([tabindex="-1"])'
        ].join(',');
        const previous = document.activeElement;
        const list = Array.from(root.querySelectorAll(qs));
        if (!list.length) {
          if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
          if (typeof root.focus === 'function') root.focus({ preventScroll: true });
        } else {
          const target = list[0];
          if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
        }
        const onKey = (e)=>{
          if(e.key==='Escape'){ e.stopPropagation(); escapeRef.current?.(); }
          if(e.key==='Tab' && list.length){ const first=list[0], last=list[list.length-1]; if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); } else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); } }
        };
        root.addEventListener('keydown', onKey);
        return ()=>{
          root.removeEventListener('keydown', onKey);
          if(previous && typeof previous.focus === 'function' && document.contains(previous)){
            try {
              previous.focus({ preventScroll: true });
            } catch {
              previous.focus();
            }
          }
        };
      },[active, ref]);
    }

    function useBodyScrollLock(active, preferredScrollRef){
      const scrollRef = useRef(0);
      const previousRef = useRef(null);

      useLayoutEffect(() => {
        if (typeof window === 'undefined') return;
        if (!active) return;

        const body = document.body;
        const html = document.documentElement;
        if (!body || !html) return;

        const fallbackY = window.scrollY || window.pageYOffset || 0;
        const preferred = preferredScrollRef && Number.isFinite(preferredScrollRef.current)
          ? preferredScrollRef.current
          : fallbackY;
        scrollRef.current = preferred;

        previousRef.current = {
          htmlLocked: html.classList.contains('is-locked'),
          bodyLocked: body.classList.contains('is-locked'),
          lockY: body.style.getPropertyValue('--lock-y'),
        };

        body.style.setProperty('--lock-y', `-${preferred}px`);
        html.classList.add('is-locked');
        body.classList.add('is-locked');

        return () => {
          const prev = previousRef.current || {};
          if (!prev.htmlLocked) html.classList.remove('is-locked');
          if (!prev.bodyLocked) body.classList.remove('is-locked');
          if (prev.lockY) body.style.setProperty('--lock-y', prev.lockY);
          else body.style.removeProperty('--lock-y');
          window.scrollTo(0, scrollRef.current || 0);
          previousRef.current = null;
        };
      }, [active, preferredScrollRef]);
    }

    // ---- Cart state ----
    /** @typedef {{ id: string, name: string, sku: string, price: number, qty: number, variants?: Record<string,string> }} CartItem */
    function useCart(){
      const normalizeCartItem = (item) => {
        if (!item) return null;
        const variants = item.variants && typeof item.variants === 'object' && !Array.isArray(item.variants) ? item.variants : {};
        const inventoryKey = item.inventoryKey || buildVariantKey(variants);
        const qty = Math.max(0, Number(item.qty) || 0);
        return {
          ...item,
          variants,
          inventoryKey,
          qty,
        };
      };

      const [items, setItems] = useState(/** @type CartItem[] */([]));
      const [notes, setNotes] = useState("");

      useEffect(() => {
        try {
          const raw = localStorage.getItem(CART_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.items)) {
              setItems(parsed.items.map(normalizeCartItem).filter(Boolean));
            }
            if (typeof parsed.notes === 'string') setNotes(parsed.notes);
          }
        } catch {}
      }, []);

      useEffect(() => {
        try {
          localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ items, notes }));
        } catch {}
      }, [items, notes]);

      const add = (item) => setItems(prev => {
        const normalized = normalizeCartItem(item);
        if (!normalized) return prev;
        const index = prev.findIndex(p =>
          p.id === normalized.id &&
          JSON.stringify(p.variants || {}) === JSON.stringify(normalized.variants || {}) &&
          (p.inventoryKey || INVENTORY_BASE_KEY) === (normalized.inventoryKey || INVENTORY_BASE_KEY)
        );
        if (index >= 0) {
          const next = [...prev];
          next[index] = {
            ...next[index],
            qty: Math.max(0, Number(next[index].qty || 0) + normalized.qty),
          };
          return next;
        }
        return [...prev, normalized];
      });

      const updateQty = (index, qty) => setItems(prev => prev.map((it, i) =>
        i === index ? { ...it, qty: Math.max(0, Number(qty) || 0) } : it
      ));

      const removeIndex = (index) => setItems(prev => prev.filter((_, i) => i !== index));
      const clear = () => setItems([]);
      const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);

      return { items, add, updateQty, removeIndex, clear, subtotal, notes, setNotes };
    }

    // ---- Owner products with Supabase integration ----
    function useOwnerProducts(){
      const [ownerProducts, setOwnerProducts] = useState(/** @type Product[] */([]));
      const [loading, setLoading] = useState(true);
      const [connectionStatus, setConnectionStatus] = useState('connecting');

      // Load products from database on mount
      useEffect(() => {
        const loadProducts = async () => {
          try {
            setConnectionStatus('connecting');
            const products = await loadProductsFromDatabase();
            setOwnerProducts(products);
            try {
              localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(products));
            } catch {}
            setConnectionStatus('connected');
          } catch (error) {
            console.error('Failed to load products from database:', error);
            setConnectionStatus('error');
            // Fallback to localStorage
            try {
              const raw = localStorage.getItem(OWNER_STORAGE_KEY);
              if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) setOwnerProducts(arr.map(normalizeProductRow).filter(Boolean));
              }
            } catch {}
          } finally {
            setLoading(false);
          }
        };

        loadProducts();
      }, []);

      // Subscribe to real-time changes
      useEffect(() => {
        if (!supabase) {
          console.warn('⚠️ Cannot setup realtime: Supabase not initialized');
          return;
        }
        
        console.log('🔄 Setting up realtime subscription...');
        
        const channel = supabase
          .channel('schema-db-changes')
          .on('postgres_changes',
            { event: '*', schema: 'public', table: 'products' },
            (payload) => {
              console.log('🔴 Realtime event received:', payload.eventType, payload);
              setOwnerProducts(prev => {
                if (payload.eventType === 'INSERT') {
                  console.log('➕ Adding product via realtime:', payload.new.name);
                  const incoming = normalizeProductRow(payload.new);
                  const i = prev.findIndex(p => p.id === incoming.id);
                  if (i >= 0) { 
                    console.log('🔄 Updating existing product instead of duplicating');
                    const next = [...prev]; 
                    next[i] = incoming; 
                    return next; 
                  }
                  return [incoming, ...prev];
                }
                if (payload.eventType === 'UPDATE') {
                  console.log('✏️ Updating product via realtime:', payload.new.name);
                  const updated = normalizeProductRow(payload.new);
                  return prev.map(p => p.id === payload.new.id ? updated : p);
                }
                if (payload.eventType === 'DELETE') {
                  console.log('🗑️ Deleting product via realtime:', payload.old.id);
                  return prev.filter(p => p.id !== payload.old.id);
                }
                return prev;
              });
            }
          )
          .subscribe((status) => {
            console.log('🔴 Realtime status:', status);
            if (status === 'SUBSCRIBED') {
              console.log('✅ Realtime subscription active!');
              setConnectionStatus('connected');
              // Catch up on any missed events by reloading data
              loadProductsFromDatabase().then(products => {
                console.log('🔄 Reloaded products after reconnection');
                const normalized = products.map(normalizeProductRow).filter(Boolean);
                setOwnerProducts(normalized);
                try {
                  localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(normalized));
                } catch {}
              }).catch(error => {
                console.error('❌ Failed to reload products after reconnection:', error);
              });
            } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED') {
              console.error('❌ Realtime subscription failed!');
              setConnectionStatus('error');
            } else {
              console.log('🔄 Realtime connecting...');
              setConnectionStatus('connecting');
            }
          });

        return () => {
          console.log('🔌 Cleaning up realtime subscription');
          channel.unsubscribe();
        };
      }, []);

      // Enhanced setOwnerProducts that saves to database
      const setOwnerProductsWithDB = (newProducts) => {
        if (typeof newProducts === 'function') {
          setOwnerProducts(prev => {
            const updated = newProducts(prev);
            const normalized = (Array.isArray(updated) ? updated : []).map(normalizeProductRow).filter(Boolean);
            try {
              localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(normalized));
            } catch {}
            return normalized;
          });
        } else {
          const normalized = (Array.isArray(newProducts) ? newProducts : []).map(normalizeProductRow).filter(Boolean);
          setOwnerProducts(normalized);
          try {
            localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(normalized));
          } catch {}
        }
      };

      // Add product function
      const addProduct = async (product) => {
        const savedProduct = await saveProductToDatabase(product);
        if (savedProduct) {
          setOwnerProductsWithDB(prev => [savedProduct, ...prev]);
          return { product: savedProduct, persisted: true };
        }
        const fallback = normalizeProductRow(product);
        setOwnerProductsWithDB(prev => [fallback, ...prev]);
        return { product: fallback, persisted: false };
      };

      // Delete product function
      const deleteProduct = async (productId) => {
        const success = await deleteProductFromDatabase(productId);
        if (success) {
          setOwnerProductsWithDB(prev => prev.filter(p => p.id !== productId));
        }
        return success;
      };

      return { 
        ownerProducts, 
        setOwnerProducts: setOwnerProductsWithDB, 
        addProduct,
        deleteProduct,
        loading,
        connectionStatus
      };
    }

    // ---- Icon Components ----
    function Logo({ className }){ return React.createElement('svg', { className, fill: 'currentColor', viewBox: '0 0 24 24' }, React.createElement('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z' })); }
    function SearchIcon({ className }){ return React.createElement('svg', { className, fill: 'none', viewBox: '0 0 24 24', strokeWidth: 1.5, stroke: 'currentColor' }, React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z' })); }
    function CartIcon({ className }){ return React.createElement('svg', { className, fill: 'none', viewBox: '0 0 24 24', strokeWidth: 1.5, stroke: 'currentColor' }, React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z' })); }
    function XIcon({ className }){ return React.createElement('svg', { className, fill: 'none', viewBox: '0 0 24 24', strokeWidth: 1.5, stroke: 'currentColor' }, React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M6 18L18 6M6 6l12 12' })); }
    function ArrowRight({ className }){ return React.createElement('svg', { className, fill: 'none', viewBox: '0 0 24 24', strokeWidth: 1.5, stroke: 'currentColor' }, React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3' })); }
    function TrashIcon({ className }){ return React.createElement('svg', { className, fill: 'none', viewBox: '0 0 24 24', strokeWidth: 1.5, stroke: 'currentColor' }, React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.164a1.5 1.5 0 0 0-1.5 1.5v.916m7.5 0a48.667 48.667 0 0 0-7.5 0' })); }
    function WhatsAppIcon({ className }){ return React.createElement('svg', { className, fill: 'currentColor', viewBox: '0 0 24 24' }, React.createElement('path', { d: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0 0 20.885 3.488' })); }

    // ---- Components ----
    function SkipLink(){
      return React.createElement('a', { href: '#main', className: 'sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 rounded-full border border-[var(--surface-border)] bg-white/90 px-3 py-2 text-sm font-semibold text-brand shadow-sm backdrop-blur' }, 'Skip to content');
    }

  function Header({ onOpenCart, search, setSearch, ownerMode, setOwnerMode, cartQty, connectionStatus, allowOwnerToggle, families, family, setFamily, categories, category, setCategory }){
      const [scrolled, setScrolled] = useState(false);
      const hdrRef = useRef(null);
      const familyScrollRef = useRef(null);
      const [familyFade, setFamilyFade] = useState({ left: false, right: false });
      useEffect(()=>{ const onScroll=()=> setScrolled(window.scrollY>4); onScroll(); window.addEventListener('scroll', onScroll, { passive:true }); return ()=> window.removeEventListener('scroll', onScroll); },[]);
      // measure header height (incl. mobile search row) -> CSS var --header-offset
      useEffect(() => {
        const setVar = () => {
          const h = hdrRef.current?.offsetHeight || 64;
          document.documentElement.style.setProperty('--header-offset', h + 'px');
        };
        setVar();
        window.addEventListener('resize', setVar, { passive:true });
        return () => window.removeEventListener('resize', setVar);
      }, [ownerMode, search, families, categories]);

      useEffect(() => {
        if (ownerMode) return;
        const updateFade = () => {
          const el = familyScrollRef.current;
          if (!el) return;
          const { scrollLeft, scrollWidth, clientWidth } = el;
          const left = scrollLeft > 0;
          const right = scrollLeft + clientWidth < scrollWidth - 1;
          setFamilyFade(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
        };
        updateFade();
        const el = familyScrollRef.current;
        if (!el) return;
        el.addEventListener('scroll', updateFade, { passive: true });
        window.addEventListener('resize', updateFade);
        return () => {
          el.removeEventListener('scroll', updateFade);
          window.removeEventListener('resize', updateFade);
        };
      }, [ownerMode, families]);
      const statusSpec = connectionStatus === 'connected'
        ? { wrapper: 'border border-emerald-200 bg-emerald-50/80 text-emerald-600', dot: 'bg-emerald-500', label: 'Online' }
        : connectionStatus === 'error'
        ? { wrapper: 'border border-rose-200 bg-rose-50/80 text-rose-600', dot: 'bg-rose-500', label: 'Offline' }
        : { wrapper: 'border border-amber-200 bg-amber-50/80 text-amber-600', dot: 'bg-amber-400 animate-pulse', label: 'Connecting' };

      const familyWrapperClasses = cx(
        'chip-scroll -mx-4',
        familyFade.left && 'show-left',
        familyFade.right && 'show-right'
      );

      return React.createElement('header', {
        ref: hdrRef,
        className: cx(
          "sticky top-0 z-40 w-full border-b border-[var(--surface-border)] bg-[rgba(246,247,251,0.85)] backdrop-blur-xl transition-shadow duration-300",
          scrolled ? "shadow-sm" : ""
        )
      },
        React.createElement('div', { className: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8' },
          React.createElement('div', { className: 'flex h-16 items-center justify-between gap-3' },
            React.createElement('div', { className: 'flex items-center gap-3 min-w-0' },
              React.createElement(Logo, { className: 'h-7 w-7 text-brand flex-shrink-0' }),
              React.createElement('div', { className: 'flex items-center gap-3 min-w-0' },
                React.createElement('span', { className: 'font-semibold text-slate-900 text-sm sm:text-base tracking-tight truncate' }, BRAND_NAME),
                React.createElement('div', {
                  className: `hidden md:flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${statusSpec.wrapper}`,
                  title: `Database ${connectionStatus}`
                },
                  React.createElement('span', { className: `inline-block h-2 w-2 rounded-full ${statusSpec.dot}` }),
                  React.createElement('span', null, statusSpec.label)
                )
              )
            ),
            React.createElement('nav', { className: 'flex items-center gap-1.5 sm:gap-2' },
              !ownerMode && React.createElement('label', { className: 'relative hidden sm:block' },
                React.createElement('span', { className: 'sr-only' }, 'Search'),
                React.createElement('input', {
                  value: search,
                  onChange: (e)=> setSearch(e.target.value),
                  placeholder: 'Search products…',
                  type: 'search',
                  className: 'w-48 md:w-64 rounded-full border border-[var(--surface-border)] bg-white/60 px-3 py-2 text-sm font-medium text-slate-600 shadow-inner backdrop-blur focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent placeholder:text-slate-400'
                }),
                React.createElement(SearchIcon, { className: 'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400' })
              ),
              allowOwnerToggle && React.createElement('button', {
                onClick: ()=> setOwnerMode(!ownerMode),
                className: cx(
                  'rounded-full border px-3 py-2 text-xs sm:text-sm font-medium transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                  ownerMode
                    ? 'border-transparent bg-brand text-white shadow-sm'
                    : 'border-[var(--surface-border)] bg-white/60 text-slate-700 hover:bg-white/80'
                )
              }, ownerMode? 'Back' : 'Owner'),
              React.createElement('button', {
                onClick: onOpenCart,
                className: 'relative inline-flex items-center gap-1 rounded-full border border-[var(--surface-border)] bg-white/60 px-2.5 sm:px-3.5 py-2 text-xs sm:text-sm font-medium text-slate-700 transition-colors hover:bg-white/80 focus:outline-none focus-visible:outline-2 focus-visible:outline-brand'
              },
                React.createElement(CartIcon, { className: 'h-4 w-4 text-brand' }),
                React.createElement('span', { className: 'hidden sm:inline' }, 'Cart'),
                cartQty > 0 && React.createElement('span', {
                  'aria-live': 'polite',
                  className: 'absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full border border-[rgba(37,99,235,0.28)] bg-[rgba(37,99,235,0.12)] px-1 text-[10px] font-semibold text-brand'
                }, String(cartQty))
              )
            )
          ),
          // Mobile search bar below header on small screens
          !ownerMode && React.createElement('div', { className: 'sm:hidden pb-0' },
            React.createElement('label', { className: 'relative block' },
              React.createElement('span', { className: 'sr-only' }, 'Search'),
              React.createElement('input', {
                value: search,
                onChange: (e)=> setSearch(e.target.value),
                placeholder: 'Search products…',
                type: 'search',
                className: 'w-full rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm font-medium text-slate-700 shadow-inner backdrop-blur focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent placeholder:text-slate-400'
              }),
              React.createElement(SearchIcon, { className: 'pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400' })
            )
          ),
          !ownerMode && Array.isArray(families) && families.length > 0 && React.createElement('div', { className: 'sm:hidden mt-2 pb-3', 'aria-label': 'Filters' },
            React.createElement('div', { className: 'grid grid-cols-2 gap-2' },
              React.createElement('label', { className: 'block' },
                React.createElement('span', { className: 'sr-only' }, 'Family'),
                React.createElement('select', {
                  value: family,
                  onChange: (e)=> setFamily(e.target.value),
                  className: 'w-full rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm font-semibold text-slate-700 shadow-inner backdrop-blur focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent'
                },
                  (families || []).map((fam)=> React.createElement('option', { key: fam, value: fam }, fam))
                )
              ),
              React.createElement('label', { className: 'block' },
                React.createElement('span', { className: 'sr-only' }, 'Category'),
                React.createElement('select', {
                  value: category,
                  onChange: (e)=> setCategory(e.target.value),
                  className: 'w-full rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm font-semibold text-slate-700 shadow-inner backdrop-blur focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent'
                },
                  (categories || []).map((cat)=> React.createElement('option', { key: cat, value: cat }, cat))
                )
              )
            )
          ),
          !ownerMode && Array.isArray(families) && families.length > 0 && React.createElement('div', { className: 'mt-2 pb-2 hidden sm:block', 'aria-label': 'Families' },
            React.createElement('div', { className: familyWrapperClasses },
              React.createElement('div', { ref: familyScrollRef, className: 'chip-scroll-inner overflow-x-auto px-4' },
                React.createElement('div', { className: 'flex gap-2 py-2 text-[11px]' },
                  families.map((fam)=> React.createElement('button', {
                    key: fam,
                    onClick: ()=> setFamily(fam),
                    'aria-pressed': family === fam,
                    className: cx(
                      'inline-flex items-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                      family === fam
                        ? 'border-transparent bg-brand text-white shadow-sm'
                        : 'border-[var(--surface-border)] bg-white/70 text-slate-600 hover:text-slate-900 hover:bg-white/90'
                    )
                  }, fam))
                )
              )
            )
          )
        )
      );
    }

    function Hero(){
      const steps = [
        { title: '1. Browse products', detail: 'Search or tap a category to find what you need.' },
        { title: '2. Open an item', detail: 'Choose the variants and quantities, then add to cart.' },
        { title: '3. Review the cart', detail: 'Adjust quantities or notes before sending.' },
        { title: '4. Send via WhatsApp', detail: 'Use the cart button to submit the full list for confirmation.' },
      ];
      return React.createElement('section', {
        'aria-labelledby': 'hero-title',
        className: 'border-b border-[var(--surface-border)] bg-hero-gradient'
      },
        React.createElement('div', { className: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16' },
          React.createElement('div', { className: 'grid gap-12 lg:grid-cols-[minmax(0,1fr)_420px] items-start' },
            React.createElement('div', { className: 'space-y-6' },
              React.createElement('span', {
                className: 'inline-flex items-center gap-2 rounded-full border border-[var(--surface-border)] bg-white/60 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-600'
              }, 'Odil Accessories'),
              React.createElement('h1', {
                id: 'hero-title',
                className: 'text-[clamp(30px,6vw,48px)] font-semibold leading-tight tracking-tight text-slate-900'
              }, 'Wholesale catalogue for partner shops'),
              React.createElement('p', {
                className: 'max-w-2xl text-base sm:text-lg text-slate-600'
              }, TAGLINE),
              React.createElement('div', { className: 'flex flex-wrap gap-3' },
                React.createElement('a', {
                  href: '#catalogue',
                  className: 'inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-muted focus:outline-none focus-visible:outline-2 focus-visible:outline-brand'
                },
                  'Browse catalogue',
                  React.createElement(ArrowRight, { className: 'h-4 w-4' })
                ),
                React.createElement('a', {
                  href: `https://wa.me/${WHATSAPP_NUMBER_E164}`,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  className: 'inline-flex items-center gap-2 rounded-full border border-[rgba(37,99,235,0.35)] bg-white/70 px-5 py-2.5 text-sm font-semibold text-slate-800 shadow-sm backdrop-blur transition hover:bg-white/90 focus:outline-none focus-visible:outline-2 focus-visible:outline-brand'
                },
                  React.createElement(WhatsAppIcon, { className: 'h-4 w-4 text-emerald-500' }),
                  'Chat on WhatsApp'
                )
              ),
              React.createElement('p', { className: 'text-sm text-slate-500' }, 'Follow the steps on the right when you place an order.')
            ),
            React.createElement('div', {
              className: 'glass-card rounded-3xl p-8 soft-shadow'
            },
              React.createElement('div', { className: 'space-y-5 text-sm text-slate-600' },
                React.createElement('h2', { className: 'text-base font-semibold text-slate-900' }, 'Order steps'),
                React.createElement('ol', { className: 'space-y-3 text-sm' },
                  steps.map((step) =>
                    React.createElement('li', {
                      key: step.title,
                      className: 'rounded-2xl border border-[var(--surface-border)] bg-white/70 px-4 py-3 backdrop-blur'
                    },
                      React.createElement('p', { className: 'text-sm font-semibold text-slate-900' }, step.title),
                      React.createElement('p', { className: 'text-xs text-slate-500 mt-1' }, step.detail)
                    )
                  )
                )
              ),
              React.createElement('div', { className: 'mt-6 flex items-center justify-between rounded-2xl border border-[var(--surface-border)] bg-white/80 px-4 py-3 text-xs uppercase tracking-[0.18em] text-slate-500' },
                React.createElement('span', null, 'Owner metrics snapshot'),
                React.createElement('span', { className: 'font-semibold text-slate-800' }, 'Realtime')
              )
            )
          )
        )
      );
    }

    function CategoryChips({ categories, active, setActive }){
      const containerRef = useRef(null);
      const [fade, setFade] = useState({ left: false, right: false });

      useEffect(() => {
        const updateFade = () => {
          const el = containerRef.current;
          if (!el) return;
          const { scrollLeft, scrollWidth, clientWidth } = el;
          const left = scrollLeft > 0;
          const right = scrollLeft + clientWidth < scrollWidth - 1;
          setFade(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
        };

        updateFade();
        const el = containerRef.current;
        if (!el) return;
        el.addEventListener('scroll', updateFade, { passive: true });
        window.addEventListener('resize', updateFade);
        return () => {
          el.removeEventListener('scroll', updateFade);
          window.removeEventListener('resize', updateFade);
        };
      }, []);

      const wrapperClasses = cx(
        'chip-scroll -mx-4',
        fade.left && 'show-left',
        fade.right && 'show-right'
      );

      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'hidden sm:block sticky top-[var(--header-offset,64px)] z-30 border-b border-[var(--surface-border)] bg-[rgba(246,247,251,0.85)] backdrop-blur-lg' },
          React.createElement('div', { className: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8', 'aria-label': 'Categories' },
            React.createElement('div', { className: wrapperClasses },
              React.createElement('div', { ref: containerRef, className: 'chip-scroll-inner overflow-x-auto px-4' },
                React.createElement('div', { className: 'flex gap-2 py-2 text-[11px]' },
                  (categories || []).map((cat)=> React.createElement('button', {
                    key: cat,
                    onClick: ()=> setActive(cat),
                    'aria-pressed': active===cat,
                    className: cx(
                      'inline-flex items-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                      active===cat
                        ? 'border-transparent bg-brand text-white shadow-sm'
                        : 'border-[var(--surface-border)] bg-white/70 text-slate-600 hover:text-slate-900 hover:bg-white/90'
                    )
                  }, cat))
                )
              )
            )
          )
        )
      );
    }

    function ProductGrid({ products, onOpen }){
      return React.createElement('section', { id: 'catalogue', 'aria-labelledby': 'catalogue-title', className: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6' },
        React.createElement('h2', { id: 'catalogue-title', className: 'sr-only' }, 'Catalogue'),
        React.createElement('div', { className: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4' },
          products.map((p)=> React.createElement(ProductCard, { key: p.id, product: p, onOpen }))
        )
      );
    }

    function ProductCard({ product, onOpen }){
      const [src, setSrc] = useState(getPrimaryImage(product));
      useEffect(()=>{ setSrc(getPrimaryImage(product)); },[product.image, product.images, product.name]);
      const variantDims = Object.entries(product.variants || {})
        .filter(([, arr]) => Array.isArray(arr) && arr.length > 0)
        .map(([label]) => label);
      const variantSummary = variantDims.map((dim) => {
        const opts = Array.isArray(product?.variants?.[dim]) ? product.variants[dim] : [];
        if (!opts.length) return null;
        const preview = opts.slice(0, 3).join(', ');
        const suffix = opts.length > 3 ? ` +${opts.length - 3}` : '';
        return `${dim}: ${preview}${suffix}`;
      }).filter(Boolean);
      const filteredSpecs = filterSpecsForDisplay(product.specs, product.variants);
      const specPairs = [];
      const specTags = [];
      filteredSpecs.forEach((spec) => {
        const pair = splitLabeledSpec(spec);
        if (pair) specPairs.push(pair);
        else specTags.push(spec);
      });
      const pairsPreview = specPairs.slice(0, 4);
      const tagsPreview = specTags.slice(0, 4);
      const extraPairCount = Math.max(specPairs.length - pairsPreview.length, 0);
      const extraTagCount = Math.max(specTags.length - tagsPreview.length, 0);
      const hasInventoryLimits = product.inventory && typeof product.inventory === 'object' && Object.keys(product.inventory).length > 0;
      const priceRange = getProductPriceRange(product);
      const priceLabel = priceRange.min === priceRange.max
        ? fmt(priceRange.min)
        : `${fmt(priceRange.min)}–${fmt(priceRange.max)}`;
      return React.createElement('article', { className: 'group flex flex-col overflow-hidden rounded-3xl border border-[var(--surface-border)] bg-white/80 backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:shadow-soft-xl' },
        React.createElement('div', { className: 'aspect-square w-full overflow-hidden bg-slate-100' },
          React.createElement('img', { src: src, onError: ()=> setSrc(buildPlaceholderDataURI(product.name)), alt: product.name, className: 'h-full w-full object-cover', loading: 'lazy' })
        ),
        React.createElement('div', { className: 'flex flex-1 flex-col gap-4 p-5' },
          React.createElement('header', null,
            React.createElement('div', { className: 'flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500' },
              hasInventoryLimits && React.createElement('span', { className: 'inline-flex items-center rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-0.5 text-amber-700' }, 'Limited stock')
            ),
            React.createElement('div', { className: 'flex items-start justify-between gap-3' },
              React.createElement('h3', { className: 'text-base font-semibold text-slate-900' }, product.name),
              React.createElement('div', { className: 'flex flex-col items-end gap-1' },
                React.createElement('span', { className: 'text-base font-semibold text-slate-900 whitespace-nowrap' }, priceLabel),
                priceRange.hasOverrides && React.createElement('span', { className: 'text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400' }, 'Price range')
              )
            ),
            product.description && React.createElement('p', {
              className: 'mt-2 text-sm text-slate-600',
              style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            }, product.description),
            React.createElement('p', { className: 'mt-2 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400' }, 'SKU ', product.sku)
          ),
          pairsPreview.length > 0 && React.createElement('dl', { className: 'grid grid-cols-1 gap-2 text-sm' },
            pairsPreview.map(({ label, detail }) =>
              React.createElement('div', { key: `${label}:${detail}`, className: 'flex items-baseline justify-between gap-3 rounded-2xl border border-[var(--surface-border)] bg-white/60 px-3 py-2' },
                React.createElement('dt', { className: 'text-xs font-semibold uppercase tracking-[0.16em] text-slate-500' }, label),
                React.createElement('dd', { className: 'text-sm font-semibold text-slate-900' }, detail)
              )
            ),
            extraPairCount > 0 && React.createElement('div', { className: 'text-xs text-slate-500' }, `+${extraPairCount} more details`)
          ),
          tagsPreview.length > 0 && React.createElement('div', { className: 'flex flex-wrap gap-1.5 text-[11px]' },
            tagsPreview.map((s)=> React.createElement('span', { key: s, className: 'inline-flex items-center rounded-full border border-[var(--surface-border)] bg-white/80 px-2.5 py-0.5 font-medium text-slate-600' }, s)),
            extraTagCount > 0 && React.createElement('span', { className: 'inline-flex items-center rounded-full border border-[var(--surface-border)] bg-white/60 px-2.5 py-0.5 font-medium text-slate-500' }, `+${extraTagCount} more`)
          ),
          variantSummary.length > 0 && React.createElement('div', { className: 'rounded-2xl border border-[var(--surface-border)] bg-white/60 px-3 py-2 text-xs text-slate-600' },
            React.createElement('div', { className: 'text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500' }, 'Options to choose'),
            React.createElement('div', { className: 'mt-1 space-y-1' },
              variantSummary.slice(0, 2).map((line) =>
                React.createElement('p', { key: line, className: 'font-medium text-slate-700' }, line)
              ),
              variantSummary.length > 2 && React.createElement('p', { className: 'text-slate-500' }, `+${variantSummary.length - 2} more option groups`)
            )
          ),
          React.createElement('div', { className: 'mt-auto' },
            React.createElement('button', {
              type: 'button',
              onClick: () => onOpen(product),
              className: 'w-full rounded-full border border-[rgba(37,99,235,0.28)] bg-white/70 px-4 py-2 text-sm font-semibold text-brand transition hover:bg-brand hover:text-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand'
            }, 'View details')
          )
        )
      );
    }

    function ProductModal({ product: rawProduct, onClose, onAdd, cartItems }){
      // Accept either a real product or a wrapper like { __edit: true, product: {...} }
      // IMPORTANT: Do this BEFORE any hooks!
      const product = (rawProduct && rawProduct.__edit && rawProduct.product)
        ? rawProduct.product
        : rawProduct;
      
      // Early return BEFORE hooks to avoid React error #310
      if (!product) return null;

      const cartItemsSafe = Array.isArray(cartItems) ? cartItems : [];
      const inventoryMap = useMemo(() => normalizeInventoryObject(product.inventory), [product.inventory]);
      const priceMap = useMemo(() => getProductPriceMap(product), [product.variants]);
      const existingQtyByKey = useMemo(() => {
        const map = {};
        cartItemsSafe.forEach((item) => {
          if (!item || item.id !== product.id) return;
          const key = item.inventoryKey || buildVariantKey(item.variants || {});
          map[key] = (map[key] || 0) + Number(item.qty || 0);
        });
        return map;
      }, [cartItemsSafe, product.id]);

      const ref = useRef(null);
      useFocusTrap(!!product, ref, onClose);

      // resolve images
      const images = (() => {
        const list = Array.isArray(product.images) && product.images.length ? product.images
                  : (product.image ? [product.image] : []);
        return (list.length ? list : [buildPlaceholderDataURI(product.name)])
          .map(src => resolveImageSrc(src, product.name));
      })();

      // ---- Variants: treat EVERY array-like dimension as multi-select
      const v = product.variants || {};
      const dims = Object.entries(v)
        .filter(([, arr]) => Array.isArray(arr) && arr.length > 0)
        .map(([label]) => label);
      const displaySpecs = useMemo(() => {
        const filtered = filterSpecsForDisplay(product.specs, product.variants);
        const pairs = [];
        const tags = [];
        filtered.forEach((spec) => {
          const pair = splitLabeledSpec(spec);
          if (pair) pairs.push(pair);
          else tags.push(spec);
        });
        return { pairs, tags };
      }, [product.specs, product.variants]);

      // selected options per dimension (default = all)
      const [active, setActive] = useState({});
      // per-combination quantities
      const [qtyMap, setQtyMap] = useState({});
      const [limitWarnings, setLimitWarnings] = useState({});

      useEffect(() => {
        if (!product) return;
        const initActive = {};
        dims.forEach(d => {
          const options = v[d] || [];
          initActive[d] = options.length ? [options[0]] : [];
        });
        setActive(initActive);

        // initialize quantity map for all current combinations
        const keys = (() => {
          if (dims.length === 0) return [INVENTORY_BASE_KEY];
          const out = [];
          const rec = (i, sel) => {
            if (i === dims.length) {
              out.push(buildVariantKey(sel));
              return;
            }
            const dim = dims[i];
            (initActive[dim] || []).forEach(opt => rec(i + 1, { ...sel, [dim]: opt }));
          };
          rec(0, {});
          return out;
        })();
        const next = {};
        keys.forEach(k => { next[k] = 0; });
        setQtyMap(next);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [product]);

      const toggle = (dim, opt) => setActive(prev => {
        const arr = prev[dim] || [];
        const next = arr.includes(opt) ? arr.filter(x => x !== opt) : [...arr, opt];
        return { ...prev, [dim]: next };
      });
      const selectAll = (dim) => setActive(prev => ({ ...prev, [dim]: [...(v[dim] || [])] }));
      const clearDim  = (dim) => setActive(prev => ({ ...prev, [dim]: [] }));
      const setQty    = (key, value) => {
        const numeric = Math.max(0, Number(value) || 0);
        setLimitWarnings(prev => {
          const limit = prev[key];
          if (limit === undefined) return prev;
          if (numeric < limit) {
            const next = { ...prev };
            delete next[key];
            return next;
          }
          return prev;
        });
        setQtyMap(prev => ({ ...prev, [key]: numeric }));
      };

      // recompute current combinations whenever selections change
      const combos = useMemo(() => {
        if (dims.length === 0) return [{ key: INVENTORY_BASE_KEY, sel: {} }];
        if (dims.some(d => (active[d] || []).length === 0)) return [];
        const out = [];
        const rec = (i, sel) => {
          if (i === dims.length) {
            out.push({ key: buildVariantKey(sel), sel });
            return;
          }
          const d = dims[i];
          (active[d] || []).forEach(opt => rec(i + 1, { ...sel, [d]: opt }));
        };
        rec(0, {});
        return out;
      }, [dims, active]);

      const onAddAll = () => {
        let addedAny = false;
        let trimmed = false;
        combos.forEach(({ key, sel }) => {
          const requested = Number(qtyMap[key] || 0);
          if (!(requested > 0)) return;
          const unitPrice = Object.prototype.hasOwnProperty.call(priceMap, key)
            ? priceMap[key]
            : (Number(product.price) || 0);
          const availableTotal = inventoryMap[key] !== undefined
            ? inventoryMap[key]
            : (key === INVENTORY_BASE_KEY ? inventoryMap[INVENTORY_BASE_KEY] : undefined);
          const used = existingQtyByKey[key] || 0;
          const remaining = typeof availableTotal === 'number' ? Math.max(availableTotal - used, 0) : undefined;
          const allowed = typeof remaining === 'number' ? Math.min(requested, remaining) : requested;
          if (allowed > 0) {
            onAdd({ id: product.id, name: product.name, sku: product.sku, price: unitPrice, qty: allowed, variants: sel, inventoryKey: key });
            addedAny = true;
            if (allowed < requested) trimmed = true;
          } else {
            trimmed = true;
          }
        });
        if (trimmed) {
          alert('Some items were adjusted to match available stock.');
        }
        if (addedAny) onClose();
      };

      const totalSelected = useMemo(() => combos.reduce((sum, { key }) => {
        const requested = Number(qtyMap[key] || 0);
        if (!Number.isFinite(requested) || requested <= 0) return sum;
        const unitPrice = Object.prototype.hasOwnProperty.call(priceMap, key)
          ? priceMap[key]
          : (Number(product.price) || 0);
        const availableTotal = inventoryMap[key] !== undefined
          ? inventoryMap[key]
          : (key === INVENTORY_BASE_KEY ? inventoryMap[INVENTORY_BASE_KEY] : undefined);
        const used = existingQtyByKey[key] || 0;
        const remaining = typeof availableTotal === 'number' ? Math.max(availableTotal - used, 0) : undefined;
        const allowed = typeof remaining === 'number' ? Math.min(requested, remaining) : requested;
        if (!(allowed > 0)) return sum;
        return sum + allowed * unitPrice;
      }, 0), [combos, qtyMap, product.price, priceMap, inventoryMap, existingQtyByKey]);

      const disabled = combos.every(({ key }) => {
        const requested = Number(qtyMap[key] || 0);
        if (!(requested > 0)) return true;
        const availableTotal = inventoryMap[key] !== undefined
          ? inventoryMap[key]
          : (key === INVENTORY_BASE_KEY ? inventoryMap[INVENTORY_BASE_KEY] : undefined);
        const used = existingQtyByKey[key] || 0;
        const remaining = typeof availableTotal === 'number' ? Math.max(availableTotal - used, 0) : undefined;
        const allowed = typeof remaining === 'number' ? Math.min(requested, remaining) : requested;
        return !(allowed > 0);
      });

      useEffect(() => {
        setLimitWarnings(prev => {
          const valid = new Set(combos.map(({ key }) => key));
          let changed = false;
          const next = {};
          Object.entries(prev).forEach(([k, val]) => {
            if (valid.has(k)) {
              next[k] = val;
            } else {
              changed = true;
            }
          });
          return changed ? next : prev;
        });
      }, [combos]);

      useEffect(() => {
        setLimitWarnings({});
      }, [product.id]);

      return (
        React.createElement('div', { 
          role: 'dialog', 
          'aria-modal': 'true', 
          'aria-labelledby': `product-title-${product.id}`, 
          className: 'fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/40 p-0 sm:p-6',
          onClick: onClose,
          onTouchMove: (e) => {
            // Prevent momentum scrolling on the backdrop
            if (e.target === e.currentTarget) {
              e.preventDefault();
            }
          },
          onWheel: (e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
            }
          }
        },
          React.createElement('div', { 
            ref: ref, 
            tabIndex: -1,
            className: 'w-full h-full sm:h-auto sm:max-w-3xl rounded-none sm:rounded-3xl border border-[var(--surface-border)] bg-[rgba(255,255,255,0.96)] backdrop-blur-xl shadow-soft-xl outline-none overscroll-contain overflow-y-auto max-h-none sm:max-h-[90vh]',
            style: { touchAction: 'pan-y' },
            onClick: (e) => e.stopPropagation()
          },
            /* header */
            React.createElement('div', { className: 'flex items-center justify-between border-b border-[var(--surface-border)] bg-white/70 px-5 py-4' },
              React.createElement('h3', { id: `product-title-${product.id}`, className: 'text-lg font-semibold text-slate-900' }, product.name),
              React.createElement('button', { onClick: onClose, className: 'rounded-full border border-transparent p-2 text-slate-500 transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand', 'aria-label': 'Close' },
                React.createElement(XIcon, { className: 'h-5 w-5' })
              )
            ),

            React.createElement('div', { className: 'grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_260px]' },
              React.createElement('div', { className: 'space-y-6' },
                React.createElement('div', { className: 'relative aspect-square w-full overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-slate-100' },
                  React.createElement('img', { src: images[0], onError: (e)=>{ e.currentTarget.src = buildPlaceholderDataURI(product.name); }, alt: `${product.name} – photo`, className: 'h-full w-full object-cover' })
                ),
                product.description && React.createElement('p', { className: 'text-sm text-slate-600' }, product.description),
                (displaySpecs.pairs.length > 0 || displaySpecs.tags.length > 0) && React.createElement('section', {
                  className: 'rounded-2xl border border-[var(--surface-border)] bg-white/80 p-4 text-sm shadow-sm backdrop-blur'
                },
                  React.createElement('h4', { className: 'text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Product information'),
                  displaySpecs.pairs.length > 0 && React.createElement('dl', { className: 'mt-3 grid grid-cols-1 gap-2' },
                    displaySpecs.pairs.map(({ label, detail }) =>
                      React.createElement('div', { key: `${label}:${detail}`, className: 'flex items-baseline justify-between gap-3' },
                        React.createElement('dt', { className: 'text-xs font-semibold uppercase tracking-[0.16em] text-slate-500' }, label),
                        React.createElement('dd', { className: 'text-sm font-semibold text-slate-900' }, detail)
                      )
                    )
                  ),
                  displaySpecs.tags.length > 0 && React.createElement('div', { className: 'mt-3 flex flex-wrap gap-1.5 text-[11px]' },
                    displaySpecs.tags.map((s) =>
                      React.createElement('span', { key: s, className: 'inline-flex items-center rounded-full border border-[var(--surface-border)] bg-white/80 px-2.5 py-0.5 font-medium text-slate-600' }, s)
                    )
                  )
                ),
                dims.map(dim => {
                  const opts = v[dim] || [];
                  const current = active[dim] || [];
                  const isColor = dim.toLowerCase().includes('color') || dim === 'Color';
                  return (
                    React.createElement('div', { key: dim, className: 'rounded-2xl border border-[var(--surface-border)] bg-white/80 p-4 text-sm shadow-sm backdrop-blur' },
                      React.createElement('div', { className: 'mb-2 flex flex-wrap items-center justify-between gap-2' },
                        React.createElement('span', { className: 'text-sm font-semibold text-slate-900' }, dim),
                        opts.length ? React.createElement('div', { className: 'flex items-center gap-2 text-xs text-slate-500' },
                          React.createElement('button', { type: 'button', onClick: ()=> selectAll(dim), className: 'rounded-full border border-[var(--surface-border)] px-2 py-1 font-medium hover:bg-white/60' }, 'All'),
                          React.createElement('button', { type: 'button', onClick: ()=> clearDim(dim), className: 'rounded-full border border-[var(--surface-border)] px-2 py-1 font-medium hover:bg-white/60' }, 'Clear')
                        ) : null
                      ),
                      React.createElement('div', { className: 'max-h-32 overflow-auto rounded-xl border border-[var(--surface-border)] bg-white/70 p-2' },
                        React.createElement('div', { className: 'flex flex-wrap gap-2 text-xs' },
                          opts.length === 0
                            ? React.createElement('p', { className: 'text-slate-500' }, 'No options')
                            : opts.map(opt => {
                                const on = current.includes(opt);
                                return React.createElement('button', {
                                  type: 'button',
                                  key: opt,
                                  onClick: ()=> toggle(dim, opt),
                                  className: cx('inline-flex items-center gap-1 rounded-full border px-3 py-1 font-medium transition focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                                    on
                                      ? 'border-transparent bg-brand text-white shadow-sm'
                                      : 'border-[var(--surface-border)] bg-white/80 text-slate-700 hover:text-slate-900 hover:bg-white'
                                  )
                                },
                                  isColor ? React.createElement(ColorDot, { name: opt }) : null,
                                  opt
                                );
                              })
                        )
                      )
                    )
                  );
                }),
                React.createElement('div', { className: 'space-y-3', 'aria-label': 'Quantities' },
                  combos.length === 0 ? (
                    React.createElement('p', { className: 'text-xs text-slate-500' }, 'Select at least one option.')
                  ) : (
                    React.createElement('div', { className: 'max-h-80 overflow-y-auto space-y-3 pr-1' },
                      combos.map(({ key, sel }) => {
                        const unitPrice = Object.prototype.hasOwnProperty.call(priceMap, key)
                          ? priceMap[key]
                          : (Number(product.price) || 0);
                        const lineQty = Number(qtyMap[key] || 0);
                        const availableTotal = inventoryMap[key] !== undefined
                          ? inventoryMap[key]
                          : (key === INVENTORY_BASE_KEY ? inventoryMap[INVENTORY_BASE_KEY] : undefined);
                        const used = existingQtyByKey[key] || 0;
                        const remaining = typeof availableTotal === 'number' ? Math.max(availableTotal - used, 0) : undefined;
                        const isOut = typeof remaining === 'number' && remaining <= 0;
                        const limitWarning = limitWarnings[key];
                        return React.createElement('div', {
                          key,
                          className: cx(
                            'rounded-2xl border px-3 py-3 text-sm shadow-sm backdrop-blur sm:flex sm:items-center sm:justify-between',
                            isOut ? 'border-rose-200 bg-rose-50/80 text-rose-700' : 'border-[var(--surface-border)] bg-white/85 text-slate-700'
                          )
                        },
                          React.createElement('div', { className: 'space-y-1 text-sm' },
                            Object.entries(sel).map(([k, val], i) => (
                              React.createElement('span', { key: `${k}-${val}` },
                                i>0 ? ' · ' : '',
                                k === 'Color'
                                  ? React.createElement('span', { className: 'inline-flex items-center gap-1' }, React.createElement(ColorDot, { name: val }), val)
                                  : React.createElement('span', { className: 'font-medium text-slate-900' }, val)
                              )
                            )),
                            Object.keys(sel).length === 0 && React.createElement('span', { className: 'font-medium text-slate-900' }, 'Quantity'),
                            React.createElement('p', { className: 'text-xs text-slate-500' },
                              'Unit: ',
                              React.createElement('span', { className: 'font-semibold text-slate-900' }, fmt(unitPrice)),
                              lineQty > 0 ? React.createElement(React.Fragment, null,
                                ' · Total: ',
                                React.createElement('span', { className: 'font-semibold text-slate-900' }, fmt(unitPrice * lineQty))
                              ) : null
                            ),
                            typeof availableTotal === 'number'
                              ? React.createElement('p', { className: 'text-xs text-slate-500' },
                                  `Remaining: ${Math.max(availableTotal - used, 0)}${used > 0 ? ` (of ${availableTotal})` : ''}`)
                              : React.createElement('p', { className: 'text-xs text-slate-500' }, 'No stock limit')
                          ),
                          React.createElement('div', { className: 'mt-2 sm:mt-0' },
                            React.createElement(NumberStepper, {
                              value: Number(qtyMap[key] || 0),
                              onChange: (v) => setQty(key, v),
                              min: 0,
                              max: typeof remaining === 'number' ? remaining : undefined,
                              onLimit: (limit) => {
                                if (typeof limit === 'number' && Number.isFinite(limit)) {
                                  setLimitWarnings(prev => ({ ...prev, [key]: limit }));
                                }
                              }
                            })
                          ),
                          limitWarning !== undefined ? React.createElement('p', { className: 'mt-2 text-xs font-medium text-rose-600 sm:ml-3 sm:mt-0 sm:text-right' }, `Only ${limitWarning} available for this selection.`) : null
                        );
                      })
                    )
                  )
                )
              ),
              React.createElement('aside', { className: 'glass-card rounded-3xl space-y-5 p-5' },
                React.createElement('div', { className: 'space-y-2 text-sm' },
                  (() => {
                    const base = Number(product.price) || 0;
                    const values = Object.values(priceMap);
                    const min = values.length ? Math.min(base, ...values) : base;
                    const max = values.length ? Math.max(base, ...values) : base;
                    const label = min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
                    const title = values.length ? 'Price range' : 'Unit price';
                    return React.createElement('div', { className: 'flex items-center justify-between text-slate-500' },
                      React.createElement('span', null, title),
                      React.createElement('span', { className: 'font-semibold text-slate-900' }, label)
                    );
                  })(),
                  React.createElement('div', { className: 'flex items-center justify-between text-slate-500' },
                    React.createElement('span', null, 'Selections'),
                    React.createElement('span', { className: 'font-medium text-slate-800' }, combos.length)
                  )
                ),
                React.createElement('div', { className: 'flex items-center justify-between rounded-2xl border border-[rgba(37,99,235,0.28)] bg-[rgba(37,99,235,0.12)] px-4 py-3 text-sm font-medium text-brand' },
                  React.createElement('span', { className: 'uppercase tracking-[0.18em]' }, 'Line total'),
                  React.createElement('span', { className: 'text-base font-semibold text-brand' }, fmt(totalSelected))
                ),
                React.createElement('p', { className: 'text-xs text-slate-500' }, 'Add items to the cart and send the final list to WhatsApp when you are ready.'),
                React.createElement('div', { className: 'flex flex-col gap-2' },
                  React.createElement('button', {
                    disabled: disabled,
                    onClick: onAddAll,
                    className: cx(
                      'w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                      disabled ? 'pointer-events-none opacity-50' : 'hover:bg-brand-muted'
                    )
                  }, 'Add to cart'),
                  React.createElement('button', {
                    onClick: onClose,
                    className: 'w-full rounded-full border border-[var(--surface-border)] bg-white/70 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand'
                  }, 'Cancel')
                )
              )
            )
          )
        )
      );
    }

    function NumberStepper({ id, value, onChange, min=0, max, onLimit }){
      const notifyLimit = (proposed) => {
        if (typeof max === 'number' && Number.isFinite(max) && typeof onLimit === 'function' && proposed > max) {
          onLimit(max);
        }
      };
      const clamp = (next, proposed)=> {
        if (typeof proposed === 'number') {
          notifyLimit(proposed);
        } else {
          notifyLimit(next);
        }
        let result = Math.max(min, next);
        if (typeof max === 'number' && Number.isFinite(max)) {
          result = Math.min(max, result);
        }
        return result;
      };
      const numericValue = Number(value) || 0;
      const atMax = typeof max === 'number' && Number.isFinite(max) && numericValue >= max;
      return React.createElement('div', { className: 'inline-flex items-center rounded-full border border-[var(--surface-border)] bg-white/70 shadow-sm backdrop-blur', role: 'group', 'aria-label': 'Quantity' },
        React.createElement('button', { onClick: ()=> onChange(clamp((Number(value)||0) - 1, (Number(value)||0) - 1)), className: 'rounded-l-full px-3 py-1.5 text-slate-700 transition hover:bg-brand-soft focus:outline-none focus-visible:outline-2 focus-visible:outline-brand touch-manipulation select-none', 'aria-label': 'Decrease quantity' }, '−'),
        React.createElement('input', {
          id: id,
          inputMode: 'numeric',
          pattern: '[0-9]*',
          value: String(value),
          onChange: (e)=>{
            const n = Number(e.target.value.replace(/[^0-9]/g,''));
            const proposed = Number.isFinite(n) ? n : min;
            onChange(Number.isFinite(n) ? clamp(proposed, proposed) : min);
          },
          className: 'w-14 appearance-none border-x border-[var(--surface-border)] bg-transparent px-2 py-1.5 text-center text-base sm:text-sm text-slate-900 focus:outline-none'
        }),
        React.createElement('button', {
          onClick: ()=> onChange(clamp((Number(value)||0) + 1, (Number(value)||0) + 1)),
          className: cx('rounded-r-full px-3 py-1.5 touch-manipulation select-none transition focus:outline-none focus-visible:outline-2 focus-visible:outline-brand', atMax ? 'cursor-not-allowed text-slate-300' : 'text-slate-700 hover:bg-brand-soft'),
          'aria-label': 'Increase quantity',
          disabled: atMax
        }, '+')
      );
    }

    async function copyToClipboardSafe(text){
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      // Fallback for older browsers / denied permissions
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch {
        return false;
      }
    }

    function CartDrawer({ open, onClose, cart, productLookup }){
      const ref = useRef(null);
      useFocusTrap(open, ref, onClose);
      const reduced = usePrefersReducedMotion();
  const message = useMemo(()=> buildWhatsAppMessage(cart.items, cart.subtotal, cart.notes), [cart.items, cart.subtotal, cart.notes]);
  const hasQty = cart.items.some(it => Number(it.qty) > 0);
  const waWeb  = `https://wa.me/${WHATSAPP_NUMBER_E164}?text=${encodeURIComponent(message)}`;
  const waDeep = `whatsapp://send?phone=${WHATSAPP_NUMBER_E164}&text=${encodeURIComponent(message)}`;
  const isMobile = /Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent);
      const [limitWarnings, setLimitWarnings] = useState({});

      useEffect(() => {
        setLimitWarnings(prev => {
          const validKeys = new Set((cart.items || []).map(item => {
            if (!item) return null;
            const invKey = item.inventoryKey || buildVariantKey(item.variants || {});
            return `${item.id || ''}::${invKey}`;
          }).filter(Boolean));
          let changed = false;
          const next = {};
          Object.entries(prev).forEach(([key, value]) => {
            if (validKeys.has(key)) {
              next[key] = value;
            } else {
              changed = true;
            }
          });
          return changed ? next : prev;
        });
      }, [cart.items]);
      return React.createElement('div', { 'aria-live': 'polite' },
        React.createElement('div', { 
          className: cx("fixed inset-0 z-40 bg-black/40 transition-opacity", open?"opacity-100":"pointer-events-none opacity-0"), 
          onClick: onClose, 
          onTouchMove: (e)=> {
            // Only prevent if the touch isn't on the drawer itself
            e.preventDefault();
          },
          onTouchStart: (e)=> {
            // Prevent momentum scrolling on backdrop
            e.preventDefault();
          },
          onWheel: (e)=> {
            e.preventDefault();
          },
          'aria-hidden': 'true' 
        }),
        React.createElement('aside', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'cart-title',
          className: cx("fixed right-0 top-0 z-50 h-full w-full max-w-md transform border-l border-[var(--surface-border)] bg-[rgba(255,255,255,0.96)] backdrop-blur-xl shadow-soft-xl outline-none overscroll-contain", reduced?"transition-none":"transition-transform duration-200 ease-out", open?"translate-x-0":"translate-x-full")
        },
          React.createElement('div', { ref: ref, className: 'flex h-full flex-col' },
            React.createElement('div', { className: 'flex items-center justify-between border-b border-[var(--surface-border)] bg-white/70 px-5 py-4' },
              React.createElement('h3', { id: 'cart-title', className: 'text-lg font-semibold text-slate-900' }, 'Your cart'),
              React.createElement('button', { onClick: onClose, className: 'rounded-full p-2 text-slate-500 transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand', 'aria-label': 'Close cart' },
                React.createElement(XIcon, { className: 'h-5 w-5' })
              )
            ),
            React.createElement('div', { className: 'flex-1 overflow-y-auto p-4', style: { touchAction: 'pan-y' } },
              cart.items.length===0 ? React.createElement('p', { className: 'text-sm text-slate-500' }, 'Your cart is empty.') : React.createElement('ul', { className: 'space-y-3' },
                cart.items.map((it,i)=> {
                  const lookupProduct = productLookup && typeof productLookup.get === 'function' ? productLookup.get(it.id) : undefined;
                  const inventory = lookupProduct ? normalizeInventoryObject(lookupProduct.inventory) : {};
                  const inventoryKey = it.inventoryKey || buildVariantKey(it.variants || {});
                  const availableTotal = inventory[inventoryKey] !== undefined
                    ? inventory[inventoryKey]
                    : (inventoryKey === INVENTORY_BASE_KEY ? inventory[INVENTORY_BASE_KEY] : undefined);
                  let usedByOthers = 0;
                  cart.items.forEach((other, idx) => {
                    if (idx === i || !other || other.id !== it.id) return;
                    const otherKey = other.inventoryKey || buildVariantKey(other.variants || {});
                    if (otherKey === inventoryKey) {
                      usedByOthers += Number(other.qty || 0);
                    }
                  });
                  const remaining = typeof availableTotal === 'number' ? Math.max(availableTotal - usedByOthers, 0) : undefined;
                  const overRequested = typeof remaining === 'number' && it.qty > remaining;
                  const remainingText = typeof remaining === 'number'
                    ? `Available: ${remaining}`
                    : null;
                  const warningKey = `${it.id || ''}::${inventoryKey}`;
                  const limitWarning = limitWarnings[warningKey];
                  return React.createElement('li', { key: i, className: cx('rounded-2xl border p-3 shadow-sm backdrop-blur transition', overRequested ? 'border-rose-200 bg-rose-50/80 text-rose-700' : 'border-[var(--surface-border)] bg-white/80 text-slate-700') },
                    React.createElement('div', { className: 'flex items-start justify-between gap-3' },
                      React.createElement('div', null,
                        React.createElement('p', { className: 'font-semibold text-slate-900' }, it.name),
                        React.createElement('p', { className: 'text-xs text-slate-500' }, 'SKU: ', it.sku),
                        it.variants && Object.keys(it.variants).length>0 && React.createElement('div', { className: 'mt-1 flex flex-wrap gap-1.5' },
                          Object.entries(it.variants).map(([k,v])=> React.createElement('span', { key: k, className: 'inline-flex items-center gap-1 rounded-full border border-[var(--surface-border)] bg-white/80 px-2 py-0.5 text-xs font-medium text-slate-600' }, k === 'Color' ? React.createElement(React.Fragment, null, React.createElement(ColorDot, { name: v }), `${k}: ${v}`) : `${k}: ${v}`))
                        ),
                        remainingText && React.createElement('p', { className: 'mt-1 text-xs text-slate-500' }, remainingText),
                        limitWarning !== undefined ? React.createElement('p', { className: 'mt-1 text-xs font-medium text-rose-600' }, `Only ${limitWarning} available for this selection.`) : null
                      ),
                      React.createElement('button', { onClick: ()=> cart.removeIndex(i), className: 'rounded-full p-1.5 text-slate-500 transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand', 'aria-label': `Remove ${it.name}` },
                        React.createElement(TrashIcon, { className: 'h-4 w-4 text-slate-500' })
                      )
                    ),
                    React.createElement('div', { className: 'mt-2 flex items-center justify-between' },
                      React.createElement(NumberStepper, {
                        value: it.qty,
                        onChange: (v)=> {
                          const next = typeof remaining === 'number' ? Math.min(v, remaining) : v;
                          cart.updateQty(i, next);
                          setLimitWarnings(prev => {
                            const limit = prev[warningKey];
                            if (limit === undefined) return prev;
                            if (next < limit) {
                              const nextWarnings = { ...prev };
                              delete nextWarnings[warningKey];
                              return nextWarnings;
                            }
                            return prev;
                          });
                        },
                        min: 0,
                        max: typeof remaining === 'number' ? remaining : undefined,
                        onLimit: (limit) => {
                          if (typeof limit === 'number' && Number.isFinite(limit)) {
                            setLimitWarnings(prev => ({ ...prev, [warningKey]: limit }));
                          }
                        }
                      }),
                      React.createElement('div', { className: 'text-sm text-slate-600' }, fmt(it.price), ' × ', it.qty, ' = ', React.createElement('span', { className: 'font-semibold text-slate-900' }, fmt(it.price*it.qty)))
                    )
                  );
                })
              )
            ),
            React.createElement('div', { className: 'border-t border-[var(--surface-border)] bg-white/60 p-4 backdrop-blur' },
              React.createElement('div', { className: 'flex items-center justify-between text-sm text-slate-600' },
                React.createElement('span', null, 'Subtotal'),
                React.createElement('span', { className: 'font-semibold text-slate-900' }, fmt(cart.subtotal))
              ),
              React.createElement('label', { className: 'mt-3 block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Notes'),
                React.createElement('textarea', {
                  value: cart.notes,
                  onChange: (e)=> cart.setNotes(e.target.value),
                  rows: 2,
                  className: 'w-full resize-none rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                  placeholder: 'Delivery preferences, color mix, etc.'
                })
              ),
              React.createElement('div', { className: 'mt-3 flex gap-3' },
                React.createElement('button', { onClick: cart.clear, className: 'flex-1 rounded-full border border-[var(--surface-border)] bg-white/70 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' }, 'Clear cart'),

                React.createElement('button', {
                  type: 'button',
                  onClick: async ()=>{
                    if (!hasQty) {
                      alert('Add at least one product before sending an order.');
                      return;
                    }
                    const overLimit = cart.items.filter((it, index) => {
                      const lookupProduct = productLookup && typeof productLookup.get === 'function' ? productLookup.get(it.id) : undefined;
                      const inventory = lookupProduct ? normalizeInventoryObject(lookupProduct.inventory) : {};
                      const key = it.inventoryKey || buildVariantKey(it.variants || {});
                      const availableTotal = inventory[key] !== undefined
                        ? inventory[key]
                        : (key === INVENTORY_BASE_KEY ? inventory[INVENTORY_BASE_KEY] : undefined);
                      if (typeof availableTotal !== 'number') return false;
                      let usedByOthers = 0;
                      cart.items.forEach((other, idx) => {
                        if (idx === index || !other || other.id !== it.id) return;
                        const otherKey = other.inventoryKey || buildVariantKey(other.variants || {});
                        if (otherKey === key) usedByOthers += Number(other.qty || 0);
                      });
                      const remaining = Math.max(availableTotal - usedByOthers, 0);
                      return it.qty > remaining;
                    });
                    if (overLimit.length > 0) {
                      alert('One or more items exceed available stock. Please adjust the quantities before sending the order.');
                      return;
                    }

                    try {
                      await callOwnerApi('createOrder', {
                        currency: CURRENCY,
                        subtotal_cents: Math.round(cart.subtotal * 100),
                        notes: cart.notes || '',
                        items: cart.items.map((item, idx) => ({
                          product_id: item.id,
                          sku: item.sku,
                          name: item.name,
                          quantity: Number(item.qty) || 0,
                          unit_price_cents: Math.round(Number(item.price || 0) * 100),
                          subtotal_cents: Math.round(Number(item.price || 0) * Number(item.qty || 0) * 100),
                          variants: item.variants || {},
                          inventory_key: item.inventoryKey || buildVariantKey(item.variants || {}),
                        })),
                      });
                    } catch (error) {
                      console.error('Failed to record order', error);
                    }

                    // 1) Copy message (best effort; still proceed if copy fails)
                    try { 
                      await copyToClipboardSafe(message); 
                      // Show clear notification that the list is copied
                      alert('✅ Your list is copied! If WhatsApp doesn\'t open, you can paste it manually.');
                    } catch {
                      // Even if copy fails, let user know they can try manually
                      alert('📋 Please copy your order manually if WhatsApp doesn\'t open automatically.');
                    }

                    // 2) Arrange auto-clear even if the page gets backgrounded (mobile deep link)
                    let cleared = false;
                    const clearAll = () => {
                      if (cleared) return;
                      cleared = true;
                      cart.clear();
                      cart.setNotes('');
                    };
                    const onHideOnce = () => clearAll();
                    window.addEventListener('pagehide', onHideOnce, { once: true });
                    document.addEventListener('visibilitychange', function handler(){
                      if (document.hidden) { clearAll(); document.removeEventListener('visibilitychange', handler); }
                    }, { once: true });

                    // 3) Open WhatsApp (mobile deep-link + fallback, or desktop web)
                    if (isMobile) {
                      // Clear BEFORE navigation so it still happens on iOS which may unload JS immediately
                      clearAll();
                      window.location.href = waDeep;
                      // Fallback to web if app didn’t catch it
                      setTimeout(()=>{ try{ window.open(waWeb, "_blank", "noopener,noreferrer"); }catch{} }, 800);
                    } else {
                      const win = window.open(waWeb, "_blank", "noopener,noreferrer");
                      // If we stayed on the page (desktop), clear shortly after launching
                      setTimeout(clearAll, 500);
                    }
                  },
                  className: cx(
                    "flex-1 inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm focus:outline-none focus-visible:outline-2 focus-visible:outline-brand",
                    hasQty ? "bg-brand hover:bg-brand-muted" : "pointer-events-none bg-[rgba(37,99,235,0.28)] text-white/70"
                  )
                },
                  'Send via WhatsApp',
                  React.createElement(WhatsAppIcon, { className: 'h-4 w-4 text-white' })
                )
              )
            )
          )
        )
      );
    }

    // ---- WhatsApp Message Builder ----
    function buildWhatsAppMessage(items, subtotal, notes) {
      const filtered = (items || []).filter(it => Number(it.qty) > 0);

      let msg = '🛒 *Order Request*\n\n';
      filtered.forEach(it => {
        msg += `• ${it.name} (SKU: ${it.sku})\n`;
        if (it.variants && Object.keys(it.variants).length > 0) {
          msg += `  Variants: ${Object.entries(it.variants).map(([k,v]) => `${k}: ${v}`).join(', ')}\n`;
        }
        msg += `  Qty: ${it.qty} × ${fmt(it.price)} = ${fmt(it.price * it.qty)}\n\n`;
      });

      msg += `*Subtotal: ${fmt(subtotal)}*\n\n`;
      if ((notes || "").trim()) {
        msg += `*Notes:* ${notes.trim()}\n\n`;
      }
      msg += 'Please confirm availability and pricing. Thank you!';
      return msg;
    }

    // ---- Owner Page (Schema-driven) ----
    function OwnerPage({ addProduct, products, removeProduct, onNotify }) {
      // Base fields
      const [category, setCategory] = useState(/** @type Category */("Phone Screens"));
      const [name, setName] = useState("");
      // Prefill Name with "<Category> — " whenever category changes,
      // but do not overwrite if the owner already typed a custom name.
      useEffect(() => {
        setName(prev => {
          const scaffoldSet = new Set(CATEGORIES);
          const prevTrim = (prev || "").trim();
          const looksLikeScaffold =
            scaffoldSet.has(prevTrim.replace(" —", "")) || prevTrim.endsWith(" —");
          if (!prevTrim || looksLikeScaffold) {
            return `${category} — `;
          }
          return prev;
        });
      }, [category]);
      const [sku, setSku] = useState("");
      const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [imagesData, setImagesData] = useState([]); // array of data URLs
      const [formErrors, setFormErrors] = useState([]);
      const [submitStatus, setSubmitStatus] = useState(null);
      const [submitting, setSubmitting] = useState(false);

      // Dynamic form state
      const [form, setForm] = useState({});

      // Helpers
      const setValue = (k, v) => {
        setFormErrors([]);
        setSubmitStatus(null);
        setForm(prev => ({ ...prev, [k]: v }));
      };
      const toggleInArray = (k, v) => setForm(prev => {
        setFormErrors([]);
        setSubmitStatus(null);
        const arr = Array.isArray(prev[k]) ? prev[k] : [];
        return { ...prev, [k]: arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v] };
      });

      function onFile(e){
        setFormErrors([]);
        setSubmitStatus(null);
        const files = Array.from(e.target.files || []);
        if(!files.length) return;
        const readers = files.map(f => new Promise(res => { const fr = new FileReader(); fr.onload = ()=> res(String(fr.result||"")); fr.readAsDataURL(f); }));
        Promise.all(readers).then(imgs => setImagesData(prev => [...prev, ...imgs]));
      }

      // SCHEMA: mapping of category -> form fields (must, also, optional) plus helpers
      const firstValue = (val) => {
        if (Array.isArray(val) && val.length) return val[0];
        if (val != null) return val;
        return "";
      };

      const SCHEMA = {
        "Phone Screens": {
          must: [
            { key: "models", label: "Phone models", type: "phoneModels" },
            { key: "display", label: "Display type/quality", type: "select", options: ["OLED – OEM", "OLED – AAA", "LCD – OEM", "LCD – AAA"] },
            { key: "frame", label: "Frame", type: "select", options: ["With frame", "Without frame"] },
          ],
          also: [
            { key: "frontColor", label: "Front color", type: "select", options: ["Black", "White"] },
            { key: "retention", label: "True Tone/Face ID retention", type: "checkbox" }
          ],
          optional: [ { key: "adhesive", label: "Pre-installed adhesive / waterproof gasket", type: "checkbox" } ],
          name: v => {
            const model = firstValue(v.models);
            return `Screen — ${model} ${v.display ? `${String(v.display).split(" ")[0]}` : ""}`.trim();
          },
          specs: v => [v.display, v.frame, v.frontColor].filter(Boolean),
        },

        "Back Glass": {
          must: [
            { key: "models", label: "Phone models", type: "phoneModels" },
            { key: "colors", label: "Colors / finish", type: "multiselect", options: CASE_COLORS },
          ],
          also: [
            { key: "adhesive", label: "Adhesive pre-installed", type: "checkbox" },
            { key: "rings", label: "With camera rings", type: "checkbox" },
          ],
          optional: [ { key: "grade", label: "Quality grade", type: "select", options: QUALITY_GRADE } ],
          name: v => `Back Glass — ${firstValue(v.models)}`.trim(),
          specs: v => [ firstValue(v.colors) || null, v.grade, v.adhesive ? "Adhesive" : null, v.rings ? "Camera rings" : null ].filter(Boolean),
        },

        "Power Banks": {
          must: [
            { key: "capacity", label: "Capacity", type: "select", options: POWER_CAPACITY },
            { key: "ports", label: "Output ports", type: "select", options: CHARGER_PORTS },
          ],
          also: [ { key: "standard", label: "Standard", type: "select", options: STANDARDS } ],
          optional: [ { key: "colour", label: "Colour", type: "select", options: CASE_COLORS } ],
          name: v => `Power bank — ${v.capacity || ""}`.trim(),
          specs: v => [v.capacity, v.ports, v.standard].filter(Boolean),
        },

        "Screen Protectors": {
          must: [
            { key: "models", label: "Phone models", type: "phoneModels" },
            { key: "material", label: "Material", type: "select", options: PROTECTOR_MATERIALS },
            { key: "pack", label: "Pack", type: "select", options: PROTECTOR_PACKS }
          ],
          also: [ { key: "finish", label: "Finish", type: "select", options: PROTECTOR_FINISH }, { key: "coverage", label: "Coverage", type: "select", options: COVERAGE } ],
          optional: [],
          name: v => {
            const model = firstValue(v.models);
            return `Protector — ${model} ${v.material ? `(${v.material})` : ""}`.trim();
          },
          specs: v => [v.material, v.finish, v.coverage].filter(Boolean),
        },

        "Batteries": {
          must: [ { key: "models", label: "Phone models", type: "phoneModels" }, { key: "grade", label: "Grade", type: "select", options: QUALITY_GRADE } ],
          also: [],
          optional: [ { key: "capacity", label: "Capacity (mAh)", type: "text", placeholder: "e.g. 3000" } ],
          name: v => `Battery — ${firstValue(v.models)}`.trim(),
          specs: v => [v.grade, v.capacity].filter(Boolean),
        },

        "Mobile Phones": {
          must: [ { key: "model", label: "Model", type: "text", placeholder: "e.g., iPhone 13" }, { key: "cond", label: "Condition/grade", type: "select", options: PHONE_GRADE }, { key: "sim", label: "SIM", type: "select", options: SIM_OPTIONS } ],
          also: [ { key: "connect", label: "Connectivity", type: "select", options: CONN_MOBILE }, { key: "warranty", label: "Warranty (months)", type: "number" } ],
          optional: [ { key: "storage", label: "Storage", type: "multiselect", options: STORAGE_OPTIONS }, { key: "ram", label: "RAM", type: "multiselect", options: RAM_OPTIONS }, { key: "color", label: "Color", type: "text" }, { key: "inbox", label: "Accessories in box", type: "text", placeholder: "Cable, charger" } ],
          name: v => `${v.model || ""} ${v.cond || ""}`.trim(),
          specs: v => [ (Array.isArray(v.storage) && v.storage[0]) || null, (Array.isArray(v.ram) && v.ram[0]) || null, v.cond, v.sim, v.connect ].filter(Boolean),
        },

        "Tablets": {
          must: [ { key: "model", label: "Model", type: "text", placeholder: "iPad 10th Gen" }, { key: "conn", label: "Connectivity", type: "select", options: CONNECTIVITY_TABLET } ],
          also: [ { key: "screen", label: "Screen size", type: "text", placeholder: '10.9"' }, { key: "warranty", label: "Warranty (months)", type: "number" } ],
          optional: [ { key: "storage", label: "Storage", type: "multiselect", options: STORAGE_OPTIONS }, { key: "ram", label: "RAM", type: "multiselect", options: RAM_OPTIONS }, { key: "cond", label: "Condition/grade", type: "select", options: PHONE_GRADE }, { key: "color", label: "Color", type: "text" }, { key: "compat", label: "Pencil/keyboard compatibility", type: "text" } ],
          name: v => `${v.model || ""} ${v.conn || ""}`.trim(),
          specs: v => [ (Array.isArray(v.storage) && v.storage[0]) || null, (Array.isArray(v.ram) && v.ram[0]) || null, v.conn, v.screen, v.cond ].filter(Boolean),
        },

        "Phone Cases": {
          must: [ { key: "models", label: "Phone models", type: "phoneModels" }, { key: "material", label: "Material", type: "select", options: CASE_MATERIALS } ],
          also: [ { key: "color", label: "Color", type: "multiselect", options: CASE_COLORS } ],
          optional: [ { key: "pattern", label: "Pattern / style", type: "text" } ],
          name: v => `Case — ${firstValue(v.models)} ${v.material ? `(${v.material})` : ""}`.trim(),
          specs: v => [v.material, firstValue(v.color) || null].filter(Boolean),
        },

        "Cables": {
          must: [ { key: "connector", label: "Connector", type: "select", options: CONNECTORS }, { key: "length", label: "Length", type: "select", options: LENGTHS } ],
          also: [ { key: "rating", label: "Power rating", type: "select", options: POWER_RATINGS }, { key: "durability", label: "Durability", type: "select", options: DURABILITY } ],
          optional: [ { key: "cert", label: "Certs", type: "select", options: CERTS } ],
          name: v => `Cable — ${v.connector || ""} ${v.length ? `(${v.length})` : ""}`.trim(),
          specs: v => [v.connector, v.length, v.rating].filter(Boolean),
        },

        "Chargers": {
          must: [ { key: "wattage", label: "Wattage", type: "select", options: CHARGER_WATTAGE || ["20W","30W","45W","65W"] }, { key: "ports", label: "Ports", type: "select", options: CHARGER_PORTS } ],
          also: [ { key: "standard", label: "Standard", type: "select", options: STANDARDS }, { key: "plug", label: "Plug type", type: "select", options: PLUG_TYPES } ],
          optional: [],
          name: v => `Charger — ${v.wattage || ""}`.trim(),
          specs: v => [v.wattage, v.ports].filter(Boolean),
        },

        "Earphones": {
          must: [ { key: "type", label: "Type", type: "select", options: ["Wired","TWS"] } ],
          also: [ { key: "connector", label: "Connector / Standard", type: "select", options: [...CONNECTORS, ...STANDARDS] } ],
          optional: [ { key: "color", label: "Color", type: "select", options: CASE_COLORS } ],
          name: v => `Earphones — ${v.type || ""}`.trim(),
          specs: v => [v.type, v.connector].filter(Boolean),
        },

        "Charging Ports": {
          must: [ { key: "models", label: "Phone models", type: "phoneModels" }, { key: "type", label: "Port type", type: "select", options: ["USB-C","Lightning","Micro-USB"] } ],
          also: [],
          optional: [ { key: "solderRequired", label: "Solder required", type: "checkbox" } ],
          name: v => `Charging port — ${firstValue(v.models)}`.trim(),
          specs: v => [v.type, v.solderRequired ? 'Solder' : null].filter(Boolean),
        },

        "Face ID": {
          must: [ { key: "models", label: "Phone models", type: "phoneModels", allowedBrands: ["iPhone"] }, { key: "service", label: "Service", type: "select", options: ["Repair","Replace","Calibration"] } ],
          also: [],
          optional: [],
          name: v => `Face ID — ${firstValue(v.models)}`.trim(),
          specs: v => [v.service].filter(Boolean),
        }
      };

      // Reset defaults when category changes
      useEffect(()=>{
        const cfg = SCHEMA[category] || { must: [], also: [], optional: [] };
        const def = {};
        const defFrom = (fields) => fields.forEach(f=>{
          if(f.type === 'select') def[f.key] = ""; // leave empty by default
          if(f.type === 'number') def[f.key] = "";
          if(f.type === 'text') def[f.key] = "";
          if(f.type === 'checkbox') def[f.key] = false;
          if(f.type === 'multiselect') def[f.key] = [];
        });
        defFrom(cfg.must); defFrom(cfg.also); defFrom(cfg.optional);
        setForm(def);
      }, [category]);

      // Field renderer
      const Field = ({ f }) => {
        if(!f) return null;
        const labelClass = 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500';
        const controlClass = 'w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand';
        if(f.type === 'select') return React.createElement('label', { className: 'block text-sm text-slate-600 space-y-1' }, React.createElement('span', { className: labelClass }, f.label), React.createElement('select', { value: form[f.key] ?? '', onChange: (e)=> setValue(f.key, e.target.value), className: controlClass }, (f.options||[]).map(opt=> React.createElement('option', { key: opt, value: opt }, opt))));
        if(f.type === 'text' || f.type === 'number') return React.createElement('label', { className: 'block text-sm text-slate-600 space-y-1' }, React.createElement('span', { className: labelClass }, f.label), React.createElement('input', { type: f.type, value: form[f.key] ?? '', onChange: (e)=> setValue(f.key, f.type === 'number' ? e.target.value.replace(/[^0-9.]/g,'') : e.target.value), placeholder: f.placeholder || '', className: controlClass }));
        if(f.type === 'checkbox') return React.createElement('label', { className: 'inline-flex items-center gap-3 rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3 py-2 text-sm text-slate-600 shadow-sm backdrop-blur' }, React.createElement('input', { type: 'checkbox', checked: !!form[f.key], onChange: (e)=> setValue(f.key, e.target.checked), className: 'h-4 w-4 rounded border-[var(--surface-border)] text-brand focus:ring-brand' }), React.createElement('span', null, f.label));
        if(f.type === 'multiselect') {
          const opts = f.options || [];
          const current = Array.isArray(form[f.key]) ? form[f.key] : [];
          return React.createElement('div', { className: 'space-y-2 rounded-2xl border border-[var(--surface-border)] bg-white/70 p-4 text-sm text-slate-600 shadow-sm backdrop-blur' },
            React.createElement('div', { className: 'flex items-center justify-between' },
              React.createElement('span', { className: 'text-sm font-semibold text-slate-800' }, f.label),
              React.createElement('div', { className: 'flex items-center gap-2 text-xs' },
                React.createElement('button', { type: 'button', onClick: ()=> setValue(f.key, opts), className: 'rounded-full border border-[var(--surface-border)] px-2 py-0.5 font-medium text-slate-600 hover:bg-white/60', title: 'Select all' }, 'All'),
                React.createElement('button', { type: 'button', onClick: ()=> setValue(f.key, []), className: 'rounded-full border border-[var(--surface-border)] px-2 py-0.5 font-medium text-slate-600 hover:bg-white/60', title: 'Clear' }, 'Clear')
              )
            ),
            React.createElement('div', { className: 'flex flex-wrap gap-1.5 text-xs' },
              opts.map(opt=> { const on = current.includes(opt); const showDot = (COLOR_SWATCH[opt] !== undefined) || /color/i.test(f.label); return React.createElement('button', { type: 'button', key: opt, onClick: ()=> toggleInArray(f.key, opt), className: cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-medium transition', on? 'border-transparent bg-brand text-white shadow-sm' : 'border-[var(--surface-border)] bg-white/80 text-slate-700 hover:text-slate-900 hover:bg-white') }, showDot ? React.createElement(React.Fragment, null, React.createElement(ColorDot, { name: opt }), opt) : opt); })
            )
          );
        }
        if (f.type === 'phoneModels') {
          const brandKey = `${f.key}Brand`;
          const brand = form[brandKey] || (f.allowedBrands ? f.allowedBrands[0] : 'iPhone');
          const models = BRAND_MODELS[brand] || [];
          const current = Array.isArray(form[f.key]) ? form[f.key] : [];
          const setBrand = (b) => {
            setValue(brandKey, b);
            setValue(f.key, []);
          };
          return React.createElement('div', { className: 'space-y-3 rounded-2xl border border-[var(--surface-border)] bg-white/70 p-4 text-sm text-slate-600 shadow-sm backdrop-blur' },
            React.createElement('div', { className: 'flex flex-wrap gap-1.5 text-xs' },
              (f.allowedBrands || PHONE_BRANDS).map(b => React.createElement('button', { type: 'button', key: b, onClick: ()=> setBrand(b), className: cx('rounded-full border px-2.5 py-1 font-medium transition', (form[`${f.key}Brand`]|| (f.allowedBrands ? f.allowedBrands[0] : 'iPhone'))===b ? 'border-transparent bg-brand text-white shadow-sm' : 'border-[var(--surface-border)] bg-white/80 text-slate-700 hover:text-slate-900 hover:bg-white') }, b))
            ),
            React.createElement('div', { className: 'flex items-center justify-between text-xs text-slate-500' },
              React.createElement('span', { className: 'font-semibold text-slate-800' }, `${brand} models`),
              React.createElement('div', { className: 'flex items-center gap-2' },
                React.createElement('button', { type: 'button', onClick: ()=> setValue(f.key, models), className: 'rounded-full border border-[var(--surface-border)] px-2 py-0.5 font-medium hover:bg-white/60', title: 'Select all' }, 'All'),
                React.createElement('button', { type: 'button', onClick: ()=> setValue(f.key, []), className: 'rounded-full border border-[var(--surface-border)] px-2 py-0.5 font-medium hover:bg-white/60', title: 'Clear' }, 'Clear')
              )
            ),
            React.createElement('div', { className: 'flex flex-wrap gap-1.5 text-xs' },
              models.map(m => { const on = current.includes(m); return React.createElement('button', { type: 'button', key: m, onClick: ()=> { const arr = Array.isArray(form[f.key]) ? form[f.key] : []; setValue(f.key, on ? arr.filter(x=>x!==m) : [...arr, m]); }, className: cx('rounded-full border px-2.5 py-1 font-medium transition', on? 'border-transparent bg-brand text-white shadow-sm' : 'border-[var(--surface-border)] bg-white/80 text-slate-700 hover:text-slate-900 hover:bg-white') }, m); })
            )
          );
        }
        return null;
      };

      // Build product
      const buildProduct = () => {
        const cfg = SCHEMA[category] || { must: [], also: [], optional: [], name: null, specs: null };
        const autoName = (cfg.name && cfg.name(form)) || `${category} item`;
        const finalName = name.trim() || autoName;
        const variantsObj = {};
        const normalizeLabel = (label, key) => {
          if (key === 'models') return 'Model';
          const lower = String(label).toLowerCase().trim();
          if (lower === 'color' || lower === 'colors' || lower === 'colour') return 'Color';
          return label.trim();
        };
        const push = (label, key, val) => {
          if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) return;
          const lbl = normalizeLabel(label, key);
          variantsObj[lbl] = Array.isArray(val) ? val : [String(val)];
        };
        [...(cfg.must||[]), ...(cfg.also||[]), ...(cfg.optional||[])].forEach(f => {
          const val = form[f.key];
          if (f.type === 'checkbox') {
            if (val) push(f.label, f.key, 'Yes');
          } else {
            push(f.label, f.key, val);
          }
        });
        if (form['modelsBrand']) push('Phone', 'modelsBrand', form['modelsBrand']);
        Object.keys(variantsObj).forEach(key => {
          const list = Array.isArray(variantsObj[key]) ? variantsObj[key].map(v => String(v).trim()).filter(Boolean) : [];
          if (!list.length) {
            delete variantsObj[key];
          } else {
            variantsObj[key] = Array.from(new Set(list));
          }
        });
        const specs = ((cfg.specs && cfg.specs(form)) || []).filter(Boolean).slice(0,6);
        const uniqueImages = Array.from(new Set((imagesData || []).filter(Boolean)));
        const product = {
          id: `owner-${Date.now()}`,
          name: finalName,
          sku: sku.trim() || `SKU-${(Math.random()*1e6|0).toString(36)}`,
          category,
          price: Number(price) || 0,
          description: description.trim(),
          image: uniqueImages[0] || undefined,
          images: uniqueImages.length ? uniqueImages : undefined,
          specs,
          variants: variantsObj
        };
        return normalizeProductRow(product);
      };

      const validateForm = () => {
        const errors = [];
        const cfg = SCHEMA[category] || { must: [] };
        const priceNumber = Number(price);
        if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
          errors.push('Price must be greater than 0');
        }

        const phoneModelsField = (cfg.must || []).find(f => f.type === 'phoneModels');
        if (phoneModelsField) {
          const models = form[phoneModelsField.key];
          if (!Array.isArray(models) || models.length === 0) {
            errors.push('Please select at least one model');
          }
        }

        const singleModelField = (cfg.must || []).find(f => f.key === 'model');
        if (singleModelField) {
          const val = String(form[singleModelField.key] ?? '').trim();
          if (!val) {
            errors.push('Model is required');
          }
        }

        return errors;
      };

      const submit = async () => {
        const errors = validateForm();
        if (errors.length) {
          setFormErrors(errors);
          setSubmitStatus(null);
          return;
        }
        const product = buildProduct();
        if (!product) return;
        setSubmitting(true);
        try {
          const result = await addProduct(product);
          const persisted = !!(result && result.persisted);
          setFormErrors([]);
          if (persisted) {
            setSubmitStatus({ type: 'success', message: 'Product added to catalogue.' });
          } else {
            setSubmitStatus({ type: 'warning', message: 'Product saved locally. Supabase sync pending.' });
            onNotify?.('warning', 'Supabase connection unavailable. Product stored locally until sync succeeds.');
          }
          setName(`${category} — `);
          setSku('');
          setPrice('');
          setDescription('');
          setImagesData([]);
          setForm({});
        } catch (error) {
          console.error('Failed to add product:', error);
          setSubmitStatus({ type: 'error', message: 'Could not save product. Check your connection and try again.' });
          onNotify?.('error', 'Could not add product. Check your connection and try again.');
        } finally {
          setSubmitting(false);
        }
      };

      const cfg = SCHEMA[category] || { must: [], also: [], optional: [] };

      return React.createElement(
        'section',
        { 'aria-labelledby': 'owner-title', className: 'mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8' },
        React.createElement('div', { className: 'glass-card space-y-6 rounded-3xl p-6 sm:p-8' },
          React.createElement('div', { className: 'space-y-2' },
            React.createElement('h2', { id: 'owner-title', className: 'text-2xl font-semibold text-slate-900' }, 'Owner — Add products'),
            React.createElement('p', { className: 'text-sm text-slate-600' }, 'Only essentials. Fields shift by category. Keep data clean; the catalogue updates instantly.')
          ),
          submitStatus && React.createElement('div', {
            className: cx(
              'rounded-2xl border px-4 py-3 text-sm shadow-sm',
              submitStatus.type === 'error'
                ? 'border-rose-200 bg-rose-50/80 text-rose-700'
                : submitStatus.type === 'warning'
                  ? 'border-amber-200 bg-amber-50/80 text-amber-700'
                  : 'border-emerald-200 bg-emerald-50/80 text-emerald-700'
            )
          }, submitStatus.message),
          formErrors.length > 0 && React.createElement('div', { className: 'rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-700 shadow-sm' },
            React.createElement('p', { className: 'font-semibold' }, 'Please fix the following:'),
            React.createElement('ul', { className: 'mt-1 list-disc space-y-0.5 pl-4' },
              formErrors.map((err, idx) => React.createElement('li', { key: idx }, err))
            )
          ),

          React.createElement('div', { className: 'space-y-4' },
            React.createElement('h3', { className: 'text-xs font-semibold uppercase tracking-[0.24em] text-slate-500' }, 'Essentials'),
            React.createElement('div', { className: 'grid grid-cols-1 gap-4 md:grid-cols-2' },
              React.createElement('label', { className: 'block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Category'),
                React.createElement('select', { value: category, onChange: (e)=> { setFormErrors([]); setSubmitStatus(null); setCategory(e.target.value); }, className: 'w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' },
                  CATEGORIES.filter(c => c !== 'All').map(c => React.createElement('option', { key: c, value: c }, c))
                )
              ),
              React.createElement('label', { className: 'block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Price'),
                React.createElement('input', { type: 'number', min: 0, step: '0.01', value: price, onChange: (e)=> { setFormErrors([]); setSubmitStatus(null); setPrice(e.target.value); }, className: 'w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' })
              ),
              React.createElement('label', { className: 'block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Name'),
                React.createElement('input', { value: name, onChange: (e)=> { setFormErrors([]); setSubmitStatus(null); setName(e.target.value); }, className: 'w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' })
              ),
              React.createElement('label', { className: 'block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'SKU'),
                React.createElement('input', { value: sku, onChange: (e)=> { setFormErrors([]); setSubmitStatus(null); setSku(e.target.value); }, className: 'w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' })
              ),
              React.createElement('label', { className: 'md:col-span-2 block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Short description'),
                React.createElement('textarea', { rows: 3, value: description, onChange: (e)=> { setFormErrors([]); setSubmitStatus(null); setDescription(e.target.value); }, className: 'w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' })
              ),
              React.createElement('label', { className: 'block text-sm text-slate-600' },
                React.createElement('span', { className: 'mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500' }, 'Photos'),
                React.createElement('input', { type: 'file', accept: 'image/*', multiple: true, onChange: onFile }),
                imagesData.length>0 && React.createElement('div', { className: 'mt-2 flex flex-wrap gap-2' },
                  imagesData.map((src, idx)=> React.createElement('div', { key: idx, className: 'relative' },
                    React.createElement('img', { src: src, alt: `preview ${idx+1}`, className: 'h-20 w-20 overflow-hidden rounded-xl border border-[var(--surface-border)] object-cover' }),
                    React.createElement('button', { type: 'button', onClick: ()=> { setFormErrors([]); setSubmitStatus(null); setImagesData(prev=> prev.filter((_,i)=> i!==idx)); }, className: 'absolute -right-1 -top-1 rounded-full border border-[var(--surface-border)] bg-white px-1 text-xs shadow', 'aria-label': `Remove photo ${idx+1}` }, '×')
                  ))
                )
              )
            )
          ),

          React.createElement('div', { className: 'space-y-3' },
            React.createElement('h3', { className: 'text-xs font-semibold uppercase tracking-[0.24em] text-slate-500' }, 'Variants & Specs'),
            React.createElement('div', { className: 'grid gap-3 md:grid-cols-2' },
              [...(cfg.must||[]), ...(cfg.also||[]), ...(cfg.optional||[])].map(f => React.createElement(Field, { key: f.key, f }))
            )
          ),

          React.createElement('div', { className: 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end' },
            React.createElement('button', {
              type: 'button',
              onClick: submit,
              disabled: submitting,
              className: cx(
                'inline-flex items-center justify-center rounded-full px-6 py-2 text-sm font-semibold text-white shadow-sm focus:outline-none focus-visible:outline-2 focus-visible:outline-brand',
                submitting ? 'bg-brand/50 cursor-not-allowed opacity-70' : 'bg-brand hover:bg-brand-muted'
              )
            }, submitting ? 'Saving...' : 'Add Product'),
            React.createElement('button', { type: 'button', onClick: ()=> window.__setOwnerManage?.(true), className: 'inline-flex items-center justify-center rounded-full border border-[var(--surface-border)] bg-white/70 px-6 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' }, 'Manage catalogue')
          )
        )
      );
    }

    // ---- Owner Manager UI ----
    function PillsMulti({ label, options, value, onChange }) {
      const setAll = ()=> onChange(options);
      const clear = ()=> onChange([]);
      const toggle = (opt)=> onChange(value.includes(opt) ? value.filter(x=>x!==opt) : [...value, opt]);
      return (
        React.createElement('div', { className: 'space-y-2 rounded-2xl border border-[var(--surface-border)] bg-white/70 p-4 text-sm text-slate-600 shadow-sm backdrop-blur' },
          React.createElement('div', { className: 'flex items-center justify-between' },
            React.createElement('span', { className: 'text-sm font-semibold text-slate-800' }, label),
            React.createElement('div', { className: 'flex items-center gap-2 text-xs' },
              React.createElement('button', { type: 'button', onClick: setAll, className: 'rounded-full border border-[var(--surface-border)] px-2 py-0.5 font-medium text-slate-600 hover:bg-white/60' }, 'All'),
              React.createElement('button', { type: 'button', onClick: clear, className: 'rounded-full border border-[var(--surface-border)] px-2 py-0.5 font-medium text-slate-600 hover:bg-white/60' }, 'Clear')
            )
          ),
          React.createElement('div', { className: 'flex flex-wrap gap-1.5 text-xs' },
            options.map(opt => {
              const isOn = value.includes(opt);
              const showDot = /color/i.test(label) || (COLOR_SWATCH[opt] !== undefined);
              return React.createElement('button', { type: 'button', key: opt, onClick: ()=> toggle(opt), className: cx('rounded-full border px-2 py-1 text-xs', isOn? 'border-transparent bg-brand text-white' : 'border-[var(--surface-border)] bg-white text-slate-700') },
                showDot ? React.createElement(React.Fragment, null,
                  React.createElement(ColorDot, { name: opt }), ' ', opt
                ) : opt
              );
            })
          )
        )
      );
    }

    function OwnerProductModal({ open, onClose, product, catalogConfig, onSave, onHide, onDelete }) {
      const ref = useRef(null);
      useFocusTrap(!!open, ref, onClose);

      const makeId = () => Math.random().toString(36).slice(2, 10);

      const parseSpecRows = (specs) => {
        const cleaned = stripMetaSpecs(specs);
        return cleaned
          .map((spec) => {
            const raw = String(spec || '').trim();
            const idx = raw.indexOf(':');
            if (idx > 0) {
              const label = raw.slice(0, idx).trim();
              const value = raw.slice(idx + 1).trim();
              if (label && value) return { id: makeId(), label, value };
            }
            return { id: makeId(), label: raw, value: '' };
          })
          .filter((row) => row.label);
      };

      const parseCsvLines = (raw) =>
        String(raw || '')
          .split(/[\n,]/g)
          .map((v) => String(v).trim())
          .filter(Boolean);

      const normalizePriceOverrides = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        Object.entries(raw).forEach(([key, value]) => {
          const normalizedKey = String(key || '').trim();
          if (!normalizedKey || normalizedKey === INVENTORY_BASE_KEY) return;
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric >= 0) out[normalizedKey] = numeric;
        });
        return out;
      };

      const [name, setName] = useState(product?.name || "");
      const [sku, setSku] = useState(product?.sku || "");
      const [category, setCategory] = useState(product?.category || "All");
      const [family, setFamily] = useState(extractFamilyFromProduct(product) || "");
      const [price, setPrice] = useState(String(product?.price ?? 0));
      const [description, setDescription] = useState(product?.description || "");
      const [specRows, setSpecRows] = useState(() => parseSpecRows(product?.specs));

      // images + gallery
      const [images, setImages] = useState(() => {
        const list = Array.isArray(product?.images) && product.images.length
          ? product.images
          : (product?.image ? [product.image] : []);
        return [...list];
      });
      const [galleryIndex, setGalleryIndex] = useState(0);

      // variants
      const [variants, setVariants] = useState(() => {
        const v = { ...(product?.variants || {}) };
        if (v.Color && !Array.isArray(v.Color)) v.Color = [v.Color];
        if (v.Model && !Array.isArray(v.Model)) v.Model = [v.Model];
        return v;
      });

      const [optionDraft, setOptionDraft] = useState({});
      const [newGroupOpen, setNewGroupOpen] = useState(false);
      const [newGroupName, setNewGroupName] = useState('');
      const [newGroupOptions, setNewGroupOptions] = useState('');

      const [inventoryEnabled, setInventoryEnabled] = useState(() => Object.keys(normalizeInventoryObject(product?.inventory)).length > 0);
      const [inventoryDraft, setInventoryDraft] = useState(() => {
        const normalized = normalizeInventoryObject(product?.inventory);
        const out = {};
        Object.entries(normalized).forEach(([key, value]) => {
          out[String(key)] = String(Math.floor(Number(value) || 0));
        });
        return out;
      });
      const [inventoryDefault, setInventoryDefault] = useState('');

      const [priceOverridesEnabled, setPriceOverridesEnabled] = useState(() => Object.keys(normalizePriceOverrides(product?.variants?.[PRICE_OVERRIDE_VARIANTS_KEY])).length > 0);
      const [priceOverridesDraft, setPriceOverridesDraft] = useState(() => {
        const normalized = normalizePriceOverrides(product?.variants?.[PRICE_OVERRIDE_VARIANTS_KEY]);
        const out = {};
        Object.entries(normalized).forEach(([key, value]) => {
          out[String(key)] = String(value);
        });
        return out;
      });

      useEffect(() => {
        if (!open) return;
        setName(product?.name || "");
        setSku(product?.sku || "");
        setCategory(product?.category || "All");
        setFamily(extractFamilyFromProduct(product) || "");
        setPrice(String(product?.price ?? 0));
        setDescription(product?.description || "");
        setSpecRows(parseSpecRows(product?.specs));
        const list = Array.isArray(product?.images) && product.images.length
          ? product.images
          : (product?.image ? [product.image] : []);
        setImages([...list]);
        setGalleryIndex(0);
        const nextVariants = { ...(product?.variants || {}) };
        if (nextVariants.Color && !Array.isArray(nextVariants.Color)) nextVariants.Color = [nextVariants.Color];
        if (nextVariants.Model && !Array.isArray(nextVariants.Model)) nextVariants.Model = [nextVariants.Model];
        setVariants(nextVariants);
        setOptionDraft({});
        setNewGroupOpen(false);
        setNewGroupName('');
        setNewGroupOptions('');
        const normalizedInventory = normalizeInventoryObject(product?.inventory);
        setInventoryEnabled(Object.keys(normalizedInventory).length > 0);
        setInventoryDraft(() => {
          const out = {};
          Object.entries(normalizedInventory).forEach(([key, value]) => {
            out[String(key)] = String(Math.floor(Number(value) || 0));
          });
          return out;
        });
        setInventoryDefault('');
        const normalizedPrices = normalizePriceOverrides(product?.variants?.[PRICE_OVERRIDE_VARIANTS_KEY]);
        setPriceOverridesEnabled(Object.keys(normalizedPrices).length > 0);
        setPriceOverridesDraft(() => {
          const out = {};
          Object.entries(normalizedPrices).forEach(([key, value]) => {
            out[String(key)] = String(value);
          });
          return out;
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, product?.id]);

      const onFiles = (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const readers = files.map(f => new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result || ""));
          fr.readAsDataURL(f);
        }));
        Promise.all(readers).then(imgs => setImages(prev => [...prev, ...imgs]));
      };

      const prevImg = () => setGalleryIndex(i => (i - 1 + images.length) % images.length);
      const nextImg = () => setGalleryIndex(i => (i + 1) % images.length);

      const familyOptions = useMemo(() => {
        const list = Array.isArray(catalogConfig?.families)
          ? catalogConfig.families.map((f) => String(f?.name || '').trim()).filter(Boolean)
          : [];
        const base = list.length ? list : ['iPhone', 'Samsung S', 'Samsung A', 'Accessories'];
        const current = String(family || '').trim();
        return current && !base.includes(current) ? [...base, current] : base;
      }, [catalogConfig, family]);

      const categoryOptions = useMemo(() => {
        const list = Array.isArray(catalogConfig?.categories) ? catalogConfig.categories.filter(Boolean) : [];
        const base = list.length ? list : CATEGORIES.filter((c) => c !== 'All');
        const current = String(category || '').trim();
        const withAll = ['All', ...base];
        return current && current !== 'All' && !base.includes(current) ? [...withAll, current] : withAll;
      }, [catalogConfig, category]);

      const familyModels = useMemo(() => {
        const famName = String(family || '').trim();
        const families = Array.isArray(catalogConfig?.families) ? catalogConfig.families : [];
        const match = families.find((f) => String(f?.name || '').trim() === famName);
        const list = Array.isArray(match?.models) ? match.models.map((m) => String(m).trim()).filter(Boolean) : [];
        if (list.length) return list;
        const lower = famName.toLowerCase();
        if (lower.includes('iphone')) return IPHONE_MODELS;
        if (lower.includes('samsung s')) return SAMSUNG_S_MODELS;
        if (lower.includes('samsung a')) return SAMSUNG_A_MODELS;
        return [...IPHONE_MODELS, ...SAMSUNG_S_MODELS, ...SAMSUNG_A_MODELS];
      }, [catalogConfig, family]);

      const customerOptionMap = useMemo(() => {
        const out = {};
        Object.entries(variants || {}).forEach(([key, val]) => {
          if (!key || String(key).startsWith('__')) return;
          if (!Array.isArray(val) || val.length === 0) return;
          out[key] = val;
        });
        return out;
      }, [variants]);

      const optionKeys = useMemo(() => {
        const keys = Object.keys(customerOptionMap);
        const priority = ['Model', 'Color'];
        keys.sort((a, b) => {
          const ai = priority.indexOf(a);
          const bi = priority.indexOf(b);
          if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          return a.localeCompare(b);
        });
        return keys;
      }, [customerOptionMap]);

      const combos = useMemo(() => computeVariantCombos(customerOptionMap), [customerOptionMap]);
      const comboKeySet = useMemo(() => new Set(combos.map(({ key }) => key)), [combos]);

      const formatComboLabel = (selection) => {
        const entries = Object.entries(selection || {})
          .filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== '')
          .sort(([a], [b]) => a.localeCompare(b));
        if (!entries.length) return 'Base product';
        return entries.map(([k, v]) => `${k}: ${v}`).join(' • ');
      };

      const models = Array.from(new Set([...(Array.isArray(variants.Model) ? variants.Model : [])]));
      const colors = Array.from(new Set([...(Array.isArray(variants.Color) ? variants.Color : [])]));

      const moveImageToFront = (index) => {
        setImages((prev) => {
          if (index <= 0 || index >= prev.length) return prev;
          const next = [...prev];
          const [picked] = next.splice(index, 1);
          next.unshift(picked);
          return next;
        });
        setGalleryIndex(0);
      };

      const removeImage = (index) => {
        setImages((prev) => prev.filter((_, i) => i !== index));
        setGalleryIndex((i) => {
          if (i === index) return 0;
          if (i > index) return i - 1;
          return i;
        });
      };

      const setRowField = (id, field, value) => {
        setSpecRows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
      };
      const addSpecRow = () => setSpecRows((prev) => [...prev, { id: makeId(), label: '', value: '' }]);
      const removeSpecRow = (id) => setSpecRows((prev) => prev.filter((row) => row.id !== id));

      const setGroupOptions = (groupKey, list) => {
        const key = String(groupKey || '').trim();
        if (!key || key.startsWith('__')) return;
        const cleaned = Array.from(new Set((Array.isArray(list) ? list : []).map((v) => String(v).trim()).filter(Boolean)));
        setVariants((prev) => {
          const next = { ...(prev || {}) };
          if (cleaned.length) next[key] = cleaned;
          else delete next[key];
          return next;
        });
      };

      const removeGroup = (groupKey) => {
        const key = String(groupKey || '').trim();
        if (!key) return;
        setVariants((prev) => {
          const next = { ...(prev || {}) };
          delete next[key];
          return next;
        });
        setOptionDraft((prev) => {
          const next = { ...(prev || {}) };
          delete next[key];
          return next;
        });
      };

      const addOptionsToGroup = (groupKey) => {
        const key = String(groupKey || '').trim();
        if (!key) return;
        const parsed = parseCsvLines(optionDraft[key] || '');
        if (!parsed.length) return;
        const current = Array.isArray(variants?.[key]) ? variants[key] : [];
        setGroupOptions(key, [...current, ...parsed]);
        setOptionDraft((prev) => ({ ...(prev || {}), [key]: '' }));
      };

      const createNewGroup = () => {
        const key = String(newGroupName || '').trim();
        if (!key || key.startsWith('__')) return;
        const parsed = parseCsvLines(newGroupOptions);
        if (!parsed.length) return;
        setGroupOptions(key, parsed);
        setNewGroupName('');
        setNewGroupOptions('');
        setNewGroupOpen(false);
      };

      const applyInventoryDefaultToAll = () => {
        const trimmed = String(inventoryDefault || '').trim();
        if (!trimmed) return;
        const numeric = Number(trimmed);
        if (!Number.isFinite(numeric) || numeric < 0) return;
        const value = String(Math.floor(numeric));
        setInventoryDraft((prev) => {
          const next = { ...(prev || {}) };
          combos.forEach(({ key }) => { next[key] = value; });
          return next;
        });
      };

      const clearInventoryAll = () => {
        setInventoryDraft((prev) => {
          const next = { ...(prev || {}) };
          combos.forEach(({ key }) => { next[key] = ''; });
          return next;
        });
      };

      const clearPricesAll = () => {
        setPriceOverridesDraft((prev) => {
          const next = { ...(prev || {}) };
          combos.forEach(({ key }) => { if (key !== INVENTORY_BASE_KEY) next[key] = ''; });
          return next;
        });
      };

      const save = () => {
        const trimmedName = name.trim() || product.name;
        const trimmedSku = sku.trim() || product.sku;
        const priceNumber = Number(price);
        const resolvedPrice = Number.isFinite(priceNumber) && priceNumber >= 0 ? priceNumber : Number(product.price) || 0;
        const resolvedCategory = String(category || product.category || '').trim() || 'All';
        const resolvedFamily = String(family || '').trim();

        const existingMetaSpecs = (Array.isArray(product?.specs) ? product.specs : [])
          .filter((s) => {
            const value = String(s || '');
            return value && value.startsWith(META_SPEC_PREFIX) && !value.startsWith(META_FAMILY_PREFIX);
          })
          .map((s) => String(s));

        const infoSpecs = specRows
          .map((row) => {
            const label = String(row?.label || '').trim();
            if (!label) return null;
            const value = String(row?.value || '').trim();
            return value ? `${label}: ${value}` : label;
          })
          .filter(Boolean);

        const specs = Array.from(new Set([
          ...(resolvedFamily ? [`${META_FAMILY_PREFIX}${resolvedFamily}`] : []),
          ...existingMetaSpecs,
          ...infoSpecs,
        ]));

        const preservedMetaVariants = {};
        if (product?.variants && typeof product.variants === 'object' && !Array.isArray(product.variants)) {
          Object.entries(product.variants).forEach(([key, val]) => {
            if (!key || key === PRICE_OVERRIDE_VARIANTS_KEY) return;
            if (Array.isArray(val)) return;
            if (String(key).startsWith('__')) preservedMetaVariants[key] = val;
          });
        }

        const sanitizedGroups = {};
        Object.entries(customerOptionMap || {}).forEach(([key, val]) => {
          const label = String(key || '').trim();
          if (!label) return;
          const list = Array.from(new Set((Array.isArray(val) ? val : []).map((v) => String(v).trim()).filter(Boolean)));
          if (list.length) sanitizedGroups[label] = list;
        });

        const nextVariants = { ...preservedMetaVariants, ...sanitizedGroups };

        if (priceOverridesEnabled) {
          const baseNumeric = resolvedPrice;
          const priceMap = {};
          Object.entries(priceOverridesDraft || {}).forEach(([key, raw]) => {
            const normalizedKey = String(key || '').trim();
            if (!normalizedKey || normalizedKey === INVENTORY_BASE_KEY) return;
            if (!comboKeySet.has(normalizedKey)) return;
            const trimmed = String(raw ?? '').trim();
            if (!trimmed) return;
            const numeric = Number(trimmed);
            if (!Number.isFinite(numeric) || numeric < 0) return;
            if (Math.abs(numeric - baseNumeric) < 1e-9) return;
            priceMap[normalizedKey] = numeric;
          });
          if (Object.keys(priceMap).length) nextVariants[PRICE_OVERRIDE_VARIANTS_KEY] = priceMap;
        }

        const nextInventory = {};
        if (inventoryEnabled) {
          Object.entries(inventoryDraft || {}).forEach(([key, raw]) => {
            const normalizedKey = String(key || '').trim();
            if (!normalizedKey) return;
            if (!comboKeySet.has(normalizedKey)) return;
            const trimmed = String(raw ?? '').trim();
            if (!trimmed) return;
            const numeric = Number(trimmed);
            if (!Number.isFinite(numeric) || numeric < 0) return;
            nextInventory[normalizedKey] = Math.floor(numeric);
          });
        }

        const uniqueImages = Array.from(new Set((images || []).map((src) => String(src || '')).filter(Boolean)));
        const normalized = normalizeProductRow({
          ...(product || {}),
          name: trimmedName,
          sku: trimmedSku,
          category: resolvedCategory,
          price: resolvedPrice,
          description,
          images: uniqueImages,
          image: uniqueImages[0] || undefined,
          specs,
          variants: nextVariants,
          inventory: nextInventory,
        });
        onSave(normalized, product?.id);
        onClose();
      };

      const isOwnerItem = !!product?.id?.startsWith?.('owner-');

      if (!open || !product) return null;

      // Centered modal like customer ProductModal (not bottom sheet)
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-0 sm:p-6" role="dialog" aria-modal="true">
          <div ref={ref} className="w-full sm:max-w-3xl rounded-3xl border border-[var(--surface-border)] bg-[rgba(255,255,255,0.96)] backdrop-blur-xl shadow-soft-xl outline-none max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--surface-border)] bg-white/70 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Edit product</h3>
              <div className="flex items-center gap-2">
                {!isOwnerItem && (
                  <button onClick={()=> { onHide(product.id); onClose(); }}
                    className="rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand">Hide base</button>
                )}
                {isOwnerItem && (
                  <button onClick={()=> { onDelete(product.id); onClose(); }}
                    className="rounded-full border border-rose-300 bg-rose-50/80 px-3.5 py-1.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 focus:outline-none focus-visible:outline-2 focus-visible:outline-rose-400">Delete</button>
                )}
                <button onClick={onClose} className="rounded-full px-3.5 py-1.5 text-sm font-semibold text-slate-500 transition hover:bg-white/70 focus:outline-none focus-visible:outline-2 focus-visible:outline-brand">Close</button>
              </div>
            </div>

            {/* Body: Same two-column grid as ProductModal */}
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              {/* Left: big image + arrows + thumbnails + add/remove */}
              <div className="flex flex-col gap-2">
                <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-gray-100">
                  <img
                    src={resolveImageSrc(images[galleryIndex] || '', product.name)}
                    onError={(e)=>{ e.currentTarget.src = buildPlaceholderDataURI(product.name); }}
                    alt={`${product.name} – photo ${galleryIndex+1} of ${images.length}`}
                    className="h-full w-full object-cover"
                  />
                  {images.length > 1 && (
                    <>
                      <button type="button" onClick={prevImg}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                        aria-label="Previous photo">‹</button>
                      <button type="button" onClick={nextImg}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                        aria-label="Next photo">›</button>
                    </>
                  )}
                </div>

                {/* thumbnails + add/remove controls */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-700 inline-flex items-center gap-2">
                    <span className="rounded-full border border-[var(--surface-border)] bg-white px-2 py-1">Add photos</span>
                    <input type="file" accept="image/*" multiple onChange={onFiles} className="sr-only" />
                  </label>
                </div>
                {images.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto">
                    {images.map((src, i)=> (
                      <div key={i} className={cx("relative h-14 w-20 flex-shrink-0 overflow-hidden rounded-md border",
                        i===galleryIndex ? "border-brand" : "border-[var(--surface-border)]")}>
                        <button type="button" onClick={()=> setGalleryIndex(i)} className="absolute inset-0">
                          <img src={resolveImageSrc(src, product.name)} alt="" className="h-full w-full object-cover" />
                        </button>
                        <button type="button" onClick={()=> removeImage(i)}
                          className="absolute -right-1 -top-1 rounded-full bg-white border p-0.5 shadow" aria-label={`Remove photo ${i+1}`}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right: editable form */}
              <div className="flex min-w-0 flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-700">Family</span>
                    <select value={family} onChange={(e) => setFamily(e.target.value)}
                      className="w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand">
                      <option value="">(none)</option>
                      {familyOptions.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-slate-700">Category</span>
                    <select value={category} onChange={(e) => setCategory(e.target.value)}
                      className="w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand">
                      {categoryOptions.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-700">Name</span>
                  <input value={name} onChange={(e)=> setName(e.target.value)}
                    className="w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"/>
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block text-slate-700">SKU</span>
                  <input value={sku} onChange={(e)=> setSku(e.target.value)}
                    className="w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"/>
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block text-slate-700">Base price</span>
                  <input type="number" min={0} step="0.01" value={price} onChange={(e)=> setPrice(e.target.value)}
                    className="w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"/>
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block text-slate-700">Description</span>
                  <textarea rows={3} value={description} onChange={(e)=> setDescription(e.target.value)}
                    className="w-full rounded-2xl border border-[var(--surface-border)] bg-white/70 px-3.5 py-2.5 text-sm text-slate-800 shadow-inner backdrop-blur focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"/>
                </label>

                <div className="rounded-2xl border border-[var(--surface-border)] bg-white/70 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-800">Product information</span>
                    <button type="button" onClick={addSpecRow}
                      className="rounded-full border border-[var(--surface-border)] bg-white/70 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-white">Add</button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {specRows.map((row) => (
                      <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center">
                        <input
                          value={row.label}
                          onChange={(e) => setRowField(row.id, 'label', e.target.value)}
                          placeholder="Label"
                          className="w-full rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                        />
                        <input
                          value={row.value}
                          onChange={(e) => setRowField(row.id, 'value', e.target.value)}
                          placeholder="Value (optional)"
                          className="w-full rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                        />
                        <button
                          type="button"
                          onClick={() => removeSpecRow(row.id)}
                          className="rounded-full border border-[var(--surface-border)] bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-white/70"
                          aria-label="Remove row"
                        >×</button>
                      </div>
                    ))}
                    {specRows.length === 0 && (
                      <p className="text-xs text-slate-500">No product information yet.</p>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-[var(--surface-border)] bg-white/70 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-800">Customer options</span>
                    <button
                      type="button"
                      onClick={() => setNewGroupOpen((v) => !v)}
                      className="rounded-full border border-[var(--surface-border)] bg-white/70 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-white"
                    >
                      Add option group
                    </button>
                  </div>

                  {newGroupOpen && (
                    <div className="mt-3 rounded-2xl border border-[var(--surface-border)] bg-white/80 p-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="block text-sm">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Group name</span>
                          <input
                            value={newGroupName}
                            onChange={(e) => setNewGroupName(e.target.value)}
                            placeholder="e.g. RAM"
                            className="w-full rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Options</span>
                          <textarea
                            rows={2}
                            value={newGroupOptions}
                            onChange={(e) => setNewGroupOptions(e.target.value)}
                            placeholder="One per line or comma-separated"
                            className="w-full rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                          />
                        </label>
                      </div>
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => { setNewGroupOpen(false); setNewGroupName(''); setNewGroupOptions(''); }}
                          className="rounded-full border border-[var(--surface-border)] bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-white/70"
                        >
                          Cancel
                        </button>
                        <button type="button" onClick={createNewGroup} className="rounded-full bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-muted">
                          Add group
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-3 grid gap-3">
                    {optionKeys.length === 0 && (
                      <p className="text-xs text-slate-500">No customer option groups yet.</p>
                    )}
                    {optionKeys.map((k) => {
                      const opts = Array.isArray(variants?.[k]) ? variants[k] : [];
                      const draft = optionDraft[k] || '';
                      const optionsList = k === 'Model'
                        ? Array.from(new Set([...(familyModels || []), ...opts]))
                        : (k === 'Color' ? Array.from(new Set([...(CASE_COLORS || []), ...opts])) : opts);

                      return (
                        <div key={k} className="space-y-2 rounded-2xl border border-[var(--surface-border)] bg-white/80 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-slate-800">{k}</span>
                            <button type="button" onClick={() => removeGroup(k)}
                              className="rounded-full border border-[var(--surface-border)] bg-white/70 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-white"
                              aria-label={`Remove ${k}`}>×</button>
                          </div>

                          {k === 'Model' || k === 'Color' ? (
                            <PillsMulti
                              label={k === 'Model' ? 'Models' : 'Colors'}
                              options={optionsList}
                              value={opts}
                              onChange={(arr) => setGroupOptions(k, arr)}
                            />
                          ) : (
                            <div className="flex flex-wrap gap-1.5 text-xs">
                              {opts.map((opt) => (
                                <span key={opt} className="inline-flex items-center gap-1 rounded-full border border-[var(--surface-border)] bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                                  {opt}
                                  <button type="button" onClick={() => setGroupOptions(k, opts.filter((x) => x !== opt))}
                                    className="text-slate-500 hover:text-slate-800" aria-label={`Remove ${opt}`}>×</button>
                                </span>
                              ))}
                              {opts.length === 0 && <span className="text-xs text-slate-500">No options yet.</span>}
                            </div>
                          )}

                          <div className="flex gap-2">
                            <input
                              value={draft}
                              onChange={(e) => setOptionDraft((prev) => ({ ...(prev || {}), [k]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addOptionsToGroup(k);
                                }
                              }}
                              placeholder="Add options (comma or newline)"
                              className="flex-1 rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                            />
                            <button type="button" onClick={() => addOptionsToGroup(k)}
                              className="rounded-full border border-[var(--surface-border)] bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-white/70">Add</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-2xl border border-[var(--surface-border)] bg-white/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-800">Stock limits (optional)</span>
                    <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                      <input type="checkbox" checked={inventoryEnabled} onChange={(e) => setInventoryEnabled(e.target.checked)} />
                      Limit stock
                    </label>
                  </div>
                  {inventoryEnabled && (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <input
                            value={inventoryDefault}
                            onChange={(e) => setInventoryDefault(e.target.value)}
                            placeholder="Default (e.g. 10)"
                            inputMode="numeric"
                            className="w-40 rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                          />
                          <button type="button" onClick={applyInventoryDefaultToAll}
                            className="rounded-full border border-[var(--surface-border)] bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-white/70">Apply</button>
                        </div>
                        <button type="button" onClick={clearInventoryAll}
                          className="rounded-full border border-[var(--surface-border)] bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-white/70">Clear</button>
                      </div>
                      <div className="max-h-56 overflow-y-auto rounded-2xl border border-[var(--surface-border)] bg-white/80 p-3 space-y-2">
                        {combos.map(({ key, selection }) => (
                          <div key={key} className="flex items-center justify-between gap-3">
                            <span className="text-xs text-slate-600">{formatComboLabel(selection)}</span>
                            <input
                              value={inventoryDraft[key] ?? ''}
                              onChange={(e) => setInventoryDraft((prev) => ({ ...(prev || {}), [key]: e.target.value }))}
                              inputMode="numeric"
                              placeholder="∞"
                              className="w-24 rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-1.5 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                            />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500">Leave blank for unlimited stock.</p>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-[var(--surface-border)] bg-white/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-800">Variant prices (optional)</span>
                    <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                      <input type="checkbox" checked={priceOverridesEnabled} onChange={(e) => setPriceOverridesEnabled(e.target.checked)} />
                      Override prices
                    </label>
                  </div>
                  {priceOverridesEnabled && (
                    <div className="mt-2 space-y-2">
                      <div className="flex justify-end">
                        <button type="button" onClick={clearPricesAll}
                          className="rounded-full border border-[var(--surface-border)] bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-white/70">Clear overrides</button>
                      </div>
                      <div className="max-h-56 overflow-y-auto rounded-2xl border border-[var(--surface-border)] bg-white/80 p-3 space-y-2">
                        {combos.map(({ key, selection }) => {
                          if (key === INVENTORY_BASE_KEY) return null;
                          return (
                            <div key={key} className="flex items-center justify-between gap-3">
                              <span className="text-xs text-slate-600">{formatComboLabel(selection)}</span>
                              <input
                                value={priceOverridesDraft[key] ?? ''}
                                onChange={(e) => setPriceOverridesDraft((prev) => ({ ...(prev || {}), [key]: e.target.value }))}
                                inputMode="decimal"
                                placeholder={String(Number(price) || 0)}
                                className="w-24 rounded-2xl border border-[var(--surface-border)] bg-white px-3 py-1.5 text-sm text-slate-800 shadow-inner focus:outline-none focus-visible:outline-2 focus-visible:outline-brand"
                              />
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-xs text-slate-500">Leave blank to use the base price.</p>
                    </div>
                  )}
                </div>

                <div className="mt-2 flex justify-end gap-3">
                  <button onClick={onClose} className="rounded-full border border-[var(--surface-border)] bg-white px-4 py-2 text-sm text-slate-900 hover:bg-white/70">Cancel</button>
                  <button onClick={save} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-muted">Save changes</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    function OwnerManager({ products, catalogConfig, onClose, onEdit, onHide, onDelete, onSave }) {
      const [search, setSearch] = useState("");
      const [editing, setEditing] = useState(null);

      const filtered = useMemo(() => {
        let arr = products;
        if (search) {
          const q = search.toLowerCase();
          arr = arr.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.description||"").toLowerCase().includes(q));
        }
        return arr;
      }, [products, search]);

      return (
        React.createElement('section', { 'aria-labelledby': 'mgr-title', className: 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6' },
          React.createElement('div', { className: 'sticky top-[var(--header-offset,64px)] z-30 border-b border-[var(--surface-border)] bg-[rgba(246,247,251,0.85)] backdrop-blur-lg' },
            React.createElement('div', { className: 'flex items-center justify-between gap-3 py-2' },
              React.createElement('h2', { id: 'mgr-title', className: 'text-base sm:text-lg font-semibold text-slate-900' }, 'Owner — Manage catalogue'),
              React.createElement('div', { className: 'flex items-center gap-2' },
                React.createElement('label', { className: 'relative' },
                  React.createElement('span', { className: 'sr-only' }, 'Search'),
                  React.createElement('input', {
                    value: search,
                    onChange: (e)=> setSearch(e.target.value),
                    placeholder: 'Search…',
                    type: 'search',
                    className: 'w-48 sm:w-64 rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-2 text-sm font-medium text-slate-600 shadow-inner backdrop-blur placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent'
                  }),
                  React.createElement(SearchIcon, { className: 'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400' })
                ),
                React.createElement('button', { onClick: onClose, className: 'rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white focus:outline-none focus-visible:outline-2 focus-visible:outline-brand' }, 'Back')
              )
            )
          ),
          React.createElement('div', { className: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4' }, (filtered||[]).map(p => React.createElement('article', { key: p.id, className: 'group flex flex-col overflow-hidden rounded-3xl border border-[var(--surface-border)] bg-white/80 backdrop-blur transition hover:-translate-y-0.5 hover:shadow-soft-xl' }, React.createElement('div', { className: 'aspect-square w-full bg-gray-100' }, React.createElement('img', { src: resolveImageSrc((Array.isArray(p.images)&&p.images[0]) || p.image || '', p.name), onError: (e)=> { e.currentTarget.src = buildPlaceholderDataURI(p.name); }, alt: p.name, className: 'h-full w-full object-cover' })), React.createElement('div', { className: 'flex flex-1 flex-col gap-3 p-4' }, React.createElement('header', null, React.createElement('h3', { className: 'text-base font-semibold text-slate-900' }, p.name), React.createElement('p', { className: 'mt-0.5 text-xs text-slate-500' }, 'SKU: ', p.sku)), React.createElement('div', { className: 'flex flex-wrap gap-1.5' }, (p.specs||[]).slice(0,4).map(s => React.createElement('span', { key: s, className: 'inline-flex items-center rounded-full border border-[var(--surface-border)] bg-white/80 px-2.5 py-0.5 text-xs font-medium text-slate-600' }, s))), React.createElement('div', { className: 'mt-auto flex items-center justify-between' }, React.createElement('span', { className: 'font-semibold text-slate-900' }, fmt(p.price)), p.minOrder && React.createElement('span', { className: 'text-xs text-slate-500' }, 'MOQ ', p.minOrder)), React.createElement('div', { className: 'flex gap-2' }, React.createElement('button', { onClick: ()=> setEditing(p), className: 'flex-1 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-muted' }, 'Edit'), p.id.startsWith('owner-') ? React.createElement('button', { onClick: ()=> onDelete(p.id), className: 'rounded-full border border-red-300 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50' }, 'Delete') : React.createElement('button', { onClick: ()=> onHide(p.id), className: 'rounded-full border border-[var(--surface-border)] bg-white/70 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-white' }, 'Hide')))))) ,
          React.createElement(OwnerProductModal, { open: !!editing, onClose: ()=> setEditing(null), product: editing, catalogConfig, onSave: onSave, onHide: onHide, onDelete: onDelete })
        )
      );
    }

    // ---- Main App ----
    function App(){
      const [products, setProducts] = useState(CATALOG);
      const lastCatalogScrollRef = React.useRef(0);
      const [search, setSearch] = useState("");
      const [category, setCategory] = useState("All");
      const [family, setFamily] = useState("All");
      const [selectedProduct, setSelectedProduct] = useState(null);
      const [cartOpen, setCartOpen] = useState(false);
      const [ownerManage, setOwnerManage] = useState(false); // owner manager UI toggle
      const [ownerModeState, setOwnerModeState] = useState(DEFAULT_OWNER_MODE && OWNER_ACCESS_ENABLED);
      const ownerMode = OWNER_PORTAL_ONLY ? true : (OWNER_ACCESS_ENABLED ? ownerModeState : false);
      const cart = useCart();
      const toggleOwnerMode = OWNER_TOGGLE_ENABLED ? setOwnerModeState : () => {};
      const [notice, setNotice] = useState(null);
      const noticeTimerRef = useRef(null);
      const pushNotice = (type, message) => {
        if (!message) return;
        setNotice({ type, message });
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
      };
      useEffect(() => () => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      }, []);
      const { ownerProducts, setOwnerProducts, addProduct, deleteProduct, loading, connectionStatus } = useOwnerProducts();
      const catalogConfig = useCatalogConfig(ownerProducts);

      const families = useMemo(() => {
        const fromConfig = (catalogConfig?.families || [])
          .map((f) => (f && typeof f === 'object' ? f.name : null))
          .filter(Boolean);
        const fallback = ['iPhone', 'Samsung S', 'Samsung A', 'Accessories'];
        const list = fromConfig.length ? fromConfig : fallback;
        const uniq = [];
        const seen = new Set();
        list.forEach((name) => {
          const trimmed = String(name || '').trim();
          if (!trimmed || seen.has(trimmed)) return;
          seen.add(trimmed);
          uniq.push(trimmed);
        });
        return ['All', ...uniq];
      }, [catalogConfig]);

      useEffect(() => {
        if (!families.includes(family)) setFamily('All');
      }, [families, family]);

      const shouldLockScroll = Boolean(selectedProduct || cartOpen);
      useBodyScrollLock(shouldLockScroll, lastCatalogScrollRef);

      // Merge base CATALOG with owner overrides/hides
      const allProducts = useMemo(() => {
        const map = new Map(CATALOG.map(p => [p.id, p]));
        const newProducts = [];
        
        ownerProducts.forEach(op => {
          if (!op || op.id === CONFIG_PRODUCT_ID) return;
          if (op.sourceId && map.has(op.sourceId)) {
            if (op.hidden) {
              map.delete(op.sourceId);
              return;
            }
            map.delete(op.sourceId);
          }
          if (!op.hidden) {
            if (!op.sourceId) {
              // This is a new product, add to newProducts array
              newProducts.push(op);
            } else {
              // This is an override of existing product
              map.set(op.id, op);
            }
          }
        });
        
        // Return new products first, then existing products
        return [...newProducts, ...Array.from(map.values())];
      }, [ownerProducts]);

      const categoryIndex = useMemo(() => {
        const byFamily = new Map();
        const all = new Set();
        allProducts.forEach((p) => {
          if (!p || p.id === CONFIG_PRODUCT_ID) return;
          const cat = String(p.category || '').trim();
          if (!cat || cat === 'All') return;
          const fam = getProductFamily(p);
          if (!byFamily.has(fam)) byFamily.set(fam, new Set());
          byFamily.get(fam).add(cat);
          all.add(cat);
        });
        return { byFamily, all };
      }, [allProducts]);

      const categories = useMemo(() => {
        const fromConfig = Array.isArray(catalogConfig?.categories) ? catalogConfig.categories.filter(Boolean) : [];
        const baseOrder = fromConfig.length ? fromConfig : CATEGORIES.filter((c) => c !== 'All');
        const visibleSet = family === 'All'
          ? categoryIndex.all
          : (categoryIndex.byFamily.get(family) || new Set());
        const ordered = baseOrder.filter((cat) => visibleSet.has(cat));
        const extras = Array.from(visibleSet)
          .filter((cat) => !baseOrder.includes(cat))
          .sort((a, b) => a.localeCompare(b));
        return ['All', ...ordered, ...extras];
      }, [catalogConfig, family, categoryIndex]);

      useEffect(() => {
        if (!categories.includes(category)) setCategory('All');
      }, [categories, category]);

      useEffect(() => {
        setCategory('All');
      }, [family]);
      const filteredProducts = useMemo(() => {
        let filtered = allProducts;
        if (family !== "All") filtered = filtered.filter(p => getProductFamily(p) === family);
        if (category !== "All") filtered = filtered.filter(p => p.category === category);
        if (search) filtered = filtered.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()) || (p.description || '').toLowerCase().includes(search.toLowerCase()));
        return filtered;
      }, [allProducts, family, category, search]);
      const productLookup = useMemo(() => {
        const map = new Map();
        allProducts.forEach((p) => {
          if (p && p.id) map.set(p.id, p);
        });
        return map;
      }, [allProducts]);

      // Functions already provided by useOwnerProducts hook
      const removeProduct = deleteProduct; // Alias for compatibility

      // expose owner manager setter globally
      useEffect(()=> { window.__setOwnerManage = setOwnerManage; return ()=> { window.__setOwnerManage = undefined; }; }, []);

      const upsertOwner = (p) => setOwnerProducts(prev => {
        const i = prev.findIndex(x => x.id === p.id);
        if (i >= 0) { const next = [...prev]; next[i] = p; return next; }
        return [...prev, p];
      });

      const saveEdit = async (edited, baseId) => {
        const isOwner = edited.id?.startsWith?.('owner-');

        // Always create an override when editing a seed/base product
        const payload = isOwner
          ? normalizeProductRow(edited)
          : normalizeProductRow({
              ...edited,
              id: `owner-${Date.now()}`,
              sourceId: baseId,       // app-side field
            });

        const saved = await upsertProductToDatabase(payload); // will write 'sourceid'
        const effective = saved || payload;
        upsertOwner(effective);
        if (saved) {
          pushNotice('success', 'Product updated.');
        } else {
          pushNotice('warning', 'Product updated locally. Supabase sync pending.');
        }
      };

      const hideBase = async (baseId) => {
        const record = normalizeProductRow({
          id: `owner-hide-${Date.now()}`,
          sourceId: baseId,             // app-side field
          hidden: true,
          name: '',
          sku: '',
          category: 'All',
          price: 0,
          description: '',
          specs: [],
        });

        const saved = await upsertProductToDatabase(record); // will write 'sourceid'
        const effective = saved || record;
        upsertOwner(effective); // keep UI in sync either way
        if (saved) {
          pushNotice('success', 'Base product hidden.');
        } else {
          pushNotice('warning', 'Base product hidden locally. Supabase sync pending.');
        }
      };

      const deleteOwnerProduct = async (id) => {
        const success = await deleteProduct(id);
        if (!success) {
          pushNotice('error', 'Could not delete product. Check your connection and try again.');
        } else {
          pushNotice('success', 'Product deleted.');
        }
        return success;
      };

  const cartQty = cart.items.reduce((sum, it) => sum + (Number(it.qty)||0), 0);

      // Show loading state while products are loading
      if (loading) {
        return React.createElement('div', { className: 'min-h-screen bg-slate-50 flex items-center justify-center' },
          React.createElement('div', { className: 'text-center' },
            React.createElement('div', { className: 'animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4' }),
            React.createElement('p', { className: 'text-slate-600' }, 'Loading products...')
          )
        );
      }

      return React.createElement('div', { className: 'min-h-screen bg-slate-50' },
        React.createElement(SkipLink),
        notice && React.createElement('div', { className: cx('fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur', notice.type === 'error' ? 'border-red-200 bg-red-50/90 text-red-700' : notice.type === 'warning' ? 'border-amber-200 bg-amber-50/90 text-amber-800' : 'border-emerald-200 bg-emerald-50/90 text-emerald-700') },
          React.createElement('div', { className: 'flex items-start gap-3' },
            React.createElement('span', { className: 'flex-1 leading-snug' }, notice.message),
          React.createElement('button', { type: 'button', onClick: ()=> setNotice(null), className: 'text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-700' }, 'Dismiss')
          )
        ),
  React.createElement(Header, { onOpenCart: ()=> { lastCatalogScrollRef.current = window.scrollY || 0; setCartOpen(true); }, search, setSearch, ownerMode, setOwnerMode: toggleOwnerMode, cartQty, connectionStatus, allowOwnerToggle: OWNER_TOGGLE_ENABLED, families, family, setFamily, categories, category, setCategory }),
        ownerMode ? (
          ownerManage ? (
            React.createElement(OwnerManager, { products: allProducts, catalogConfig, onClose: ()=> setOwnerManage(false), onEdit: (p)=> { lastCatalogScrollRef.current = window.scrollY || 0; setSelectedProduct({ __edit: true, product: p }); }, onHide: (baseId)=> hideBase(baseId), onDelete: (id)=> deleteOwnerProduct(id), onSave: saveEdit })
          ) : (
            React.createElement(OwnerPage, { addProduct: addProduct, products: ownerProducts, removeProduct: (id)=> deleteOwnerProduct(id), onNotify: pushNotice })
          )
        ) : (
          React.createElement(React.Fragment, null, React.createElement(Hero), React.createElement(CategoryChips, { categories, active: category, setActive: setCategory }), React.createElement(ProductGrid, { 
            products: filteredProducts, 
            onOpen: (p) => {
              lastCatalogScrollRef.current = window.scrollY || 0;
              setSelectedProduct(p && p.__edit && p.product ? p.product : p);
            } 
          }))
        ),
        React.createElement(ProductModal, { 
          product: selectedProduct, 
          onClose: ()=> {
            setSelectedProduct(null);
          }, 
          onAdd: cart.add,
          cartItems: cart.items
        }),
        React.createElement(CartDrawer, { open: cartOpen, onClose: ()=> setCartOpen(false), cart, productLookup })
      );
    }

    // ---- Render ----
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(App));
  
