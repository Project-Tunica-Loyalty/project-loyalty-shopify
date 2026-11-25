import {useEffect, useState} from 'preact/hooks';

const API = 'https://shopify.reglrs.ai/checkout/loyalty';

async function request(action, fields) {
  const token = await shopify.sessionToken.get();
  const response = await fetch(API, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify({action, ...fields}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not connect your loyalty account.');
  return data;
}

export function LoyaltyAccess({onLinked}) {
  const [mode, setMode] = useState('link');
  const [step, setStep] = useState('phone');
  const [countryCode, setCountryCode] = useState('+1');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [name, setName] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [marketingAccepted, setMarketingAccepted] = useState(false);
  const [context, setContext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (mode !== 'signup' || context) return;
    let active = true;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${API}?view=signup`, {headers: {Authorization: `Bearer ${token}`}});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Loyalty signup is unavailable.');
        if (active) setContext(data);
      } catch (error) {
        if (active) setMessage(error.message || 'Loyalty signup is unavailable.');
      }
    })();
    return () => { active = false; };
  }, [mode, context]);

  function switchMode(nextMode) {
    setMode(nextMode);
    setStep('phone');
    setOtp('');
    setChallengeId('');
    setMessage('');
  }

  async function submit(action, fields, nextStep) {
    setBusy(true);
    setMessage('');
    try {
      const data = await request(action, fields);
      if (data.challengeId) setChallengeId(data.challengeId);
      if (data.signupVerificationToken) setVerificationToken(data.signupVerificationToken);
      if (nextStep) setStep(nextStep);
      else onLinked();
    } catch (error) {
      setMessage(error.message || 'Could not connect your loyalty account.');
    } finally {
      setBusy(false);
    }
  }

  return <s-section heading="Connect Project Loyalty">
    <s-stack gap="base">
      <s-text>Connect your loyalty account to use points in this checkout.</s-text>
      <s-stack direction="inline" gap="base">
        <s-button variant={mode === 'link' ? 'primary' : 'secondary'} onClick={() => switchMode('link')}>I have an account</s-button>
        <s-button variant={mode === 'signup' ? 'primary' : 'secondary'} onClick={() => switchMode('signup')}>Join loyalty</s-button>
      </s-stack>
      {step === 'phone' && <s-stack gap="base">
        <s-text-field label="Country code" value={countryCode} onChange={(event) => setCountryCode(event.currentTarget.value)} />
        <s-phone-field label="Loyalty phone number" value={phoneNumber} onChange={(event) => setPhoneNumber(event.currentTarget.value)} />
        <s-button disabled={busy || !countryCode || !phoneNumber || (mode === 'signup' && (!context?.termsUrl || !context?.privacyUrl))}
          onClick={() => submit(mode === 'signup' ? 'signup-send' : 'send-otp', {countryCode, phoneNumber}, 'otp')}>
          Send verification code
        </s-button>
      </s-stack>}
      {step === 'otp' && <s-stack gap="base">
        <s-text-field label="Verification code" value={otp} onChange={(event) => setOtp(event.currentTarget.value)} />
        <s-button disabled={busy || !otp || !challengeId}
          onClick={() => submit(mode === 'signup' ? 'signup-verify' : 'verify-otp', {challengeId, otp}, mode === 'signup' ? 'profile' : null)}>
          Verify and {mode === 'signup' ? 'continue' : 'connect'}
        </s-button>
        {mode === 'signup' && <s-button disabled={busy} onClick={() => submit('signup-resend', {challengeId}, 'otp')}>Resend code</s-button>}
      </s-stack>}
      {mode === 'signup' && step === 'profile' && <s-stack gap="base">
        <s-text-field label="Your name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <s-text>Review the <s-link href={context?.termsUrl}>loyalty terms</s-link> and <s-link href={context?.privacyUrl}>privacy policy</s-link>.</s-text>
        <s-checkbox label="I accept the loyalty program terms" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.currentTarget.checked)} />
        <s-checkbox label="Send me offers by SMS (optional)" checked={marketingAccepted} onChange={(event) => setMarketingAccepted(event.currentTarget.checked)} />
        <s-button disabled={busy || !name || !termsAccepted || !verificationToken}
          onClick={() => submit('signup-complete', {name, signupVerificationToken: verificationToken, termsVersion: context?.termsVersion, termsAccepted, marketingAccepted}, null)}>
          Join and connect
        </s-button>
      </s-stack>}
      {message && <s-banner tone="warning">{message}</s-banner>}
    </s-stack>
  </s-section>;
}
