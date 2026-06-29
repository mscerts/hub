// Microsoft Clarity Consent Integration
// Clarity is loaded by MainLayout.astro — this script only handles consent.

// Handle consent changes
function handleConsentChange(preferences) {
  if (!preferences) return;
  
  // Wait for Clarity to be available, then send consent
  const sendConsent = () => {
    if (typeof window.clarity === 'function') {
      try {
        window.clarity('consentv2', {
          ad_Storage: 'denied',
          analytics_Storage: preferences.analytics_storage
        });
        
        console.log('Consent sent to Clarity:', preferences);
      } catch (error) {
        console.error('Failed to send consent to Clarity:', error);
      }
    } else {
      // Retry after a short delay
      setTimeout(sendConsent, 100);
    }
  };
  
  sendConsent();
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Wait for consent manager to be available
  const waitForConsentManager = () => {
    if (typeof window.cookieConsentManager !== 'undefined') {
      const { cookieConsentManager } = window;
      
      // Subscribe to consent changes
      cookieConsentManager.subscribe((state) => {
        if (state.preferences) {
          handleConsentChange(state.preferences);
        }
      });
      
      // If consent already exists, send it
      const currentPreferences = cookieConsentManager.getPreferences();
      if (currentPreferences && cookieConsentManager.hasAnyConsent()) {
        handleConsentChange(currentPreferences);
      }
    } else {
      // Retry after a short delay
      setTimeout(waitForConsentManager, 50);
    }
  };
  
  waitForConsentManager();
});

// Handle consent granted event
window.addEventListener('consentGranted', (event) => {
  handleConsentChange(event.detail);
});

// Export for use in other scripts
export { handleConsentChange };
