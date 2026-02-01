// Cookie Consent Store and Utilities
// This module handles all cookie consent logic and Microsoft Clarity integration

export interface ConsentPreferences {
  analytics_storage: 'granted' | 'denied';
}

export interface ConsentState {
  isInitialized: boolean;
  showBanner: boolean;
  preferences: ConsentPreferences | null;
  timestamp: number | null;
}

// Default consent state
const defaultConsentState: ConsentState = {
  isInitialized: false,
  showBanner: true,
  preferences: null,
  timestamp: null
};

// Storage keys
const CONSENT_STORAGE_KEY = 'msft_cookie_consent';
const CONSENT_EXPIRY_DAYS = 365;

// Cookie consent manager class
export class CookieConsentManager {
  private state: ConsentState = { ...defaultConsentState };
  private listeners: ((state: ConsentState) => void)[] = [];

  constructor() {
    this.loadConsentState();
  }

  // Load consent state from localStorage
  private loadConsentState(): void {
    try {
      const stored = localStorage.getItem(CONSENT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        
        // Check if consent has expired
        if (parsed.timestamp && this.isConsentExpired(parsed.timestamp)) {
          this.clearConsent();
          return;
        }

        this.state = {
          ...parsed,
          isInitialized: true,
          showBanner: !parsed.preferences
        };
      }
    } catch (error) {
      console.warn('Failed to load consent state:', error);
      this.clearConsent();
    }
  }

  // Save consent state to localStorage
  private saveConsentState(): void {
    try {
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({
        ...this.state,
        timestamp: Date.now()
      }));
    } catch (error) {
      console.warn('Failed to save consent state:', error);
    }
  }

  // Check if consent has expired
  private isConsentExpired(timestamp: number): boolean {
    const expiryTime = timestamp + (CONSENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    return Date.now() > expiryTime;
  }

  // Get current consent state
  getState(): ConsentState {
    return { ...this.state };
  }

  // Subscribe to state changes
  subscribe(listener: (state: ConsentState) => void): () => void {
    this.listeners.push(listener);
    
    // Immediately call with current state
    listener(this.getState());
    
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  // Notify all listeners of state changes
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.getState()));
  }

  // Set consent preferences
  setConsent(preferences: ConsentPreferences): void {
    this.state = {
      ...this.state,
      preferences,
      showBanner: false,
      timestamp: Date.now()
    };

    this.saveConsentState();
    this.notifyListeners();
    this.sendConsentToClarity(preferences);

    // Dispatch custom event
    window.dispatchEvent(new CustomEvent('consentGranted', {
      detail: preferences
    }));
  }

  // Accept all cookies
  acceptAll(): void {
    this.setConsent({
      analytics_storage: 'granted'
    });
  }

  // Reject all cookies
  rejectAll(): void {
    this.setConsent({
      analytics_storage: 'denied'
    });
  }

  // Show consent banner again
  showBanner(): void {
    this.state.showBanner = true;
    this.notifyListeners();
  }

  // Hide consent banner
  hideBanner(): void {
    this.state.showBanner = false;
    this.notifyListeners();
  }

  // Clear all consent data
  clearConsent(): void {
    this.state = { ...defaultConsentState };
    localStorage.removeItem(CONSENT_STORAGE_KEY);
    this.notifyListeners();

    // Clear Clarity cookies
    if (typeof window.clarity === 'function') {
      window.clarity('consent', false);
    }
  }

  // Send consent to Microsoft Clarity
  private sendConsentToClarity(preferences: ConsentPreferences): void {
    if (typeof window.clarity === 'function') {
      try {
        window.clarity('consentv2', {
          ad_Storage: 'denied', // Always deny ad storage since we don't use advertising cookies
          analytics_Storage: preferences.analytics_storage
        });
        
        console.log('Consent sent to Clarity:', preferences);
      } catch (error) {
        console.warn('Failed to send consent to Clarity:', error);
      }
    } else {
      console.warn('Clarity is not available. Consent will be sent when Clarity loads.');
      
      // Store consent for when Clarity becomes available
      window.addEventListener('load', () => {
        if (typeof window.clarity === 'function') {
          this.sendConsentToClarity(preferences);
        }
      });
    }
  }

  // Check if specific consent is granted
  hasConsent(type: keyof ConsentPreferences): boolean {
    return this.state.preferences?.[type] === 'granted' || false;
  }

  // Check if any consent is granted
  hasAnyConsent(): boolean {
    return this.hasConsent('analytics_storage');
  }

  // Get consent preferences
  getPreferences(): ConsentPreferences | null {
    return this.state.preferences;
  }
}

// Global instance
export const cookieConsentManager = new CookieConsentManager();

// Extend Window interface for TypeScript
declare global {
  interface Window {
    clarity: (command: string, ...args: any[]) => void;
    cookieConsentManager: CookieConsentManager;
  }
}

// Make manager globally available
if (typeof window !== 'undefined') {
  window.cookieConsentManager = cookieConsentManager;
}