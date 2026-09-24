/** Password-reset email copy in every language the frontend supports. "LawFilings" itself stays
 *  untranslated, matching how the site's own header/wordmark is never localized. */
export interface PasswordResetEmailCopy {
  subject: string;
  greeting: (name: string) => string;
  intro: string;
  expiryNote: string;
  ignoreNote: string;
  rtl?: boolean;
}

export const PASSWORD_RESET_EMAIL_COPY: Record<string, PasswordResetEmailCopy> = {
  en: {
    subject: 'Reset your LawFilings password',
    greeting: (name) => `Hi ${name},`,
    intro: 'We received a request to reset your LawFilings password. Set a new one here:',
    expiryNote: 'This link expires in 1 hour and can be used once.',
    ignoreNote: "If you didn't ask for this, you can ignore this email — your password won't change.",
  },
  hi: {
    subject: 'अपना LawFilings पासवर्ड रीसेट करें',
    greeting: (name) => `नमस्ते ${name},`,
    intro: 'हमें आपका LawFilings पासवर्ड रीसेट करने का अनुरोध मिला है। नया पासवर्ड यहाँ सेट करें:',
    expiryNote: 'यह लिंक 1 घंटे में समाप्त हो जाएगा और केवल एक बार इस्तेमाल किया जा सकता है।',
    ignoreNote: 'अगर आपने यह अनुरोध नहीं किया है, तो इस ईमेल को अनदेखा करें — आपका पासवर्ड नहीं बदलेगा।',
  },
  pa: {
    subject: 'ਆਪਣਾ LawFilings ਪਾਸਵਰਡ ਰੀਸੈੱਟ ਕਰੋ',
    greeting: (name) => `ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ ${name},`,
    intro: 'ਸਾਨੂੰ ਤੁਹਾਡਾ LawFilings ਪਾਸਵਰਡ ਰੀਸੈੱਟ ਕਰਨ ਦੀ ਬੇਨਤੀ ਮਿਲੀ ਹੈ। ਨਵਾਂ ਪਾਸਵਰਡ ਇੱਥੇ ਸੈੱਟ ਕਰੋ:',
    expiryNote: 'ਇਹ ਲਿੰਕ 1 ਘੰਟੇ ਵਿੱਚ ਖਤਮ ਹੋ ਜਾਵੇਗਾ ਅਤੇ ਸਿਰਫ਼ ਇੱਕ ਵਾਰ ਵਰਤਿਆ ਜਾ ਸਕਦਾ ਹੈ।',
    ignoreNote: 'ਜੇ ਤੁਸੀਂ ਇਹ ਬੇਨਤੀ ਨਹੀਂ ਕੀਤੀ, ਤਾਂ ਇਸ ਈਮੇਲ ਨੂੰ ਨਜ਼ਰਅੰਦਾਜ਼ ਕਰੋ — ਤੁਹਾਡਾ ਪਾਸਵਰਡ ਨਹੀਂ ਬਦਲੇਗਾ।',
  },
  gu: {
    subject: 'તમારો LawFilings પાસવર્ડ રીસેટ કરો',
    greeting: (name) => `નમસ્તે ${name},`,
    intro: 'અમને તમારો LawFilings પાસવર્ડ રીસેટ કરવાની વિનંતી મળી છે. નવો પાસવર્ડ અહીં સેટ કરો:',
    expiryNote: 'આ લિંક 1 કલાકમાં સમાપ્ત થઈ જશે અને ફક્ત એક જ વાર વાપરી શકાશે.',
    ignoreNote: 'જો તમે આ વિનંતી નથી કરી, તો આ ઇમેઇલને અવગણો — તમારો પાસવર્ડ બદલાશે નહીં.',
  },
  as: {
    subject: 'আপোনাৰ LawFilings পাছৱৰ্ড ৰিছেট কৰক',
    greeting: (name) => `নমস্কাৰ ${name},`,
    intro: 'আমি আপোনাৰ LawFilings পাছৱৰ্ড ৰিছেট কৰাৰ অনুৰোধ পাইছোঁ। নতুন পাছৱৰ্ড ইয়াত ছেট কৰক:',
    expiryNote: "এই লিংকটো ১ ঘণ্টাত সমাপ্ত হ'ব আৰু কেৱল এবাৰ ব্যৱহাৰ কৰিব পাৰি।",
    ignoreNote: "যদি আপুনি এই অনুৰোধ কৰা নাছিল, তেন্তে এই ইমেইলটো আওকাণ কৰক — আপোনাৰ পাছৱৰ্ড সলনি নহ'ব।",
  },
  bn: {
    subject: 'আপনার LawFilings পাসওয়ার্ড রিসেট করুন',
    greeting: (name) => `হ্যালো ${name},`,
    intro: 'আমরা আপনার LawFilings পাসওয়ার্ড রিসেট করার অনুরোধ পেয়েছি। নতুন পাসওয়ার্ড এখানে সেট করুন:',
    expiryNote: 'এই লিংকটি ১ ঘণ্টার মধ্যে মেয়াদ শেষ হয়ে যাবে এবং একবারই ব্যবহার করা যাবে।',
    ignoreNote: 'আপনি যদি এই অনুরোধ না করে থাকেন, তাহলে এই ইমেইলটি উপেক্ষা করুন — আপনার পাসওয়ার্ড পরিবর্তন হবে না।',
  },
  mr: {
    subject: 'तुमचा LawFilings पासवर्ड रीसेट करा',
    greeting: (name) => `नमस्कार ${name},`,
    intro: 'तुमचा LawFilings पासवर्ड रीसेट करण्याची विनंती आम्हाला मिळाली आहे. नवीन पासवर्ड येथे सेट करा:',
    expiryNote: 'ही लिंक 1 तासात कालबाह्य होईल आणि फक्त एकदाच वापरता येईल.',
    ignoreNote: 'तुम्ही ही विनंती केली नसेल, तर हा ईमेल दुर्लक्षित करा — तुमचा पासवर्ड बदलणार नाही.',
  },
  ta: {
    subject: 'உங்கள் LawFilings கடவுச்சொல்லை மீட்டமைக்கவும்',
    greeting: (name) => `வணக்கம் ${name},`,
    intro: 'உங்கள் LawFilings கடவுச்சொல்லை மீட்டமைக்கும் கோரிக்கையைப் பெற்றோம். புதிய கடவுச்சொல்லை இங்கே அமைக்கவும்:',
    expiryNote: 'இந்த இணைப்பு 1 மணி நேரத்தில் காலாவதியாகும், ஒரே ஒரு முறை மட்டுமே பயன்படுத்த முடியும்.',
    ignoreNote: 'இதை நீங்கள் கோரவில்லை என்றால், இந்த மின்னஞ்சலைப் புறக்கணிக்கவும் — உங்கள் கடவுச்சொல் மாறாது.',
  },
  te: {
    subject: 'మీ LawFilings పాస్‌వర్డ్‌ను రీసెట్ చేయండి',
    greeting: (name) => `నమస్కారం ${name},`,
    intro: 'మీ LawFilings పాస్‌వర్డ్‌ను రీసెట్ చేయమని మాకు అభ్యర్థన వచ్చింది. కొత్త పాస్‌వర్డ్‌ను ఇక్కడ సెట్ చేయండి:',
    expiryNote: 'ఈ లింక్ 1 గంటలో గడువు ముగుస్తుంది మరియు ఒక్కసారి మాత్రమే ఉపయోగించవచ్చు.',
    ignoreNote: 'మీరు దీన్ని అభ్యర్థించకపోతే, ఈ ఇమెయిల్‌ను పట్టించుకోవద్దు — మీ పాస్‌వర్డ్ మారదు.',
  },
  kn: {
    subject: 'ನಿಮ್ಮ LawFilings ಪಾಸ್‌ವರ್ಡ್ ಅನ್ನು ಮರುಹೊಂದಿಸಿ',
    greeting: (name) => `ನಮಸ್ಕಾರ ${name},`,
    intro: 'ನಿಮ್ಮ LawFilings ಪಾಸ್‌ವರ್ಡ್ ಮರುಹೊಂದಿಸುವ ವಿನಂತಿ ನಮಗೆ ಬಂದಿದೆ. ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ಅನ್ನು ಇಲ್ಲಿ ಹೊಂದಿಸಿ:',
    expiryNote: 'ಈ ಲಿಂಕ್ 1 ಗಂಟೆಯಲ್ಲಿ ಮುಕ್ತಾಯಗೊಳ್ಳುತ್ತದೆ ಮತ್ತು ಒಮ್ಮೆ ಮಾತ್ರ ಬಳಸಬಹುದು.',
    ignoreNote: 'ನೀವು ಇದನ್ನು ವಿನಂತಿಸದಿದ್ದರೆ, ಈ ಇಮೇಲ್ ಅನ್ನು ನಿರ್ಲಕ್ಷಿಸಿ — ನಿಮ್ಮ ಪಾಸ್‌ವರ್ಡ್ ಬದಲಾಗುವುದಿಲ್ಲ.',
  },
  ml: {
    subject: 'നിങ്ങളുടെ LawFilings പാസ്‌വേഡ് പുനഃസജ്ജമാക്കുക',
    greeting: (name) => `നമസ്കാരം ${name},`,
    intro: 'നിങ്ങളുടെ LawFilings പാസ്‌വേഡ് പുനഃസജ്ജമാക്കാനുള്ള അഭ്യർത്ഥന ഞങ്ങൾക്ക് ലഭിച്ചു. പുതിയ പാസ്‌വേഡ് ഇവിടെ സജ്ജമാക്കുക:',
    expiryNote: 'ഈ ലിങ്ക് 1 മണിക്കൂറിനുള്ളിൽ കാലഹരണപ്പെടും, ഒരു തവണ മാത്രമേ ഉപയോഗിക്കാനാകൂ.',
    ignoreNote: 'ഇത് നിങ്ങൾ അഭ്യർത്ഥിച്ചതല്ലെങ്കിൽ, ഈ ഇമെയിൽ അവഗണിക്കുക — നിങ്ങളുടെ പാസ്‌വേഡ് മാറില്ല.',
  },
  or: {
    subject: 'ଆପଣଙ୍କ LawFilings ପାସୱାର୍ଡ ରିସେଟ୍ କରନ୍ତୁ',
    greeting: (name) => `ନମସ୍କାର ${name},`,
    intro: 'ଆମେ ଆପଣଙ୍କ LawFilings ପାସୱାର୍ଡ ରିସେଟ୍ କରିବାର ଅନୁରୋଧ ପାଇଛୁ। ନୂଆ ପାସୱାର୍ଡ ଏଠାରେ ସେଟ୍ କରନ୍ତୁ:',
    expiryNote: 'ଏହି ଲିଙ୍କ 1 ଘଣ୍ଟାରେ ସମାପ୍ତ ହେବ ଏବଂ କେବଳ ଥରେ ବ୍ୟବହାର ହୋଇପାରିବ।',
    ignoreNote: 'ଯଦି ଆପଣ ଏହା ଅନୁରୋଧ କରିନାହାଁନ୍ତି, ତେବେ ଏହି ଇମେଲକୁ ଅଣଦେଖା କରନ୍ତୁ — ଆପଣଙ୍କ ପାସୱାର୍ଡ ବଦଳିବ ନାହିଁ।',
  },
  ur: {
    subject: 'اپنا LawFilings پاسورڈ ری سیٹ کریں',
    greeting: (name) => `السلام علیکم ${name}،`,
    intro: 'ہمیں آپ کا LawFilings پاسورڈ ری سیٹ کرنے کی درخواست موصول ہوئی ہے۔ نیا پاسورڈ یہاں سیٹ کریں:',
    expiryNote: 'یہ لنک 1 گھنٹے میں ختم ہو جائے گا اور صرف ایک بار استعمال کیا جا سکتا ہے۔',
    ignoreNote: 'اگر آپ نے یہ درخواست نہیں کی، تو اس ای میل کو نظر انداز کریں — آپ کا پاسورڈ تبدیل نہیں ہوگا۔',
    rtl: true,
  },
};

export function getPasswordResetEmailCopy(language: string | undefined): PasswordResetEmailCopy {
  return PASSWORD_RESET_EMAIL_COPY[language ?? ''] ?? PASSWORD_RESET_EMAIL_COPY.en;
}
