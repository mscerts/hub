// Microsoft Clarity Integration with Cookie Consent
// This script initializes Clarity and handles consent properly

// Clarity project ID - Replace with your actual Clarity project ID
const CLARITY_PROJECT_ID = 'u7pei4s9cq'; // TODO: Replace with actual ID

// Initialize Clarity script
function initializeClarity() {
  if (typeof window.clarity !== 'undefined') {
    console.log('Clarity already initialized');
    return;
  }

  // Create Clarity script
  const script = document.createElement('script');
  script.innerHTML = `
    (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "${CLARITY_PROJECT_ID}");
  `;
  
  document.head.appendChild(script);
  
  console.log('Clarity script initialized');
}

// Handle consent changes
function handleConsentChange(preferences) {
  if (!preferences) return;
  
  // Initialize Clarity if not already done
  if (typeof window.clarity === 'undefined') {
    initializeClarity();
  }
  
  // Wait for Clarity to be available, then send consent
  const sendConsent = () => {
    if (typeof window.clarity === 'function') {
      try {
        window.clarity('consentv2', {
          ad_Storage: 'denied', // Always deny ad storage since we don't use advertising cookies
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
      
      // If consent already exists, initialize Clarity
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
export { initializeClarity, handleConsentChange };