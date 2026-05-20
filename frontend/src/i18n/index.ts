import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import zhTW from "./zh-TW.json";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "zh-TW",
    supportedLngs: ["zh-TW", "en"],
    resources: {
      "zh-TW": { translation: zhTW },
      en: { translation: en },
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "etp.lang",
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
