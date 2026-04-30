import zh from "@worker/i18n/locales/zh";
import i18next from "i18next";

const i18n = i18next.createInstance();
i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  defaultNS: "common",
  resources: { zh },
  interpolation: { escapeValue: false },
});

export const t = i18n.t.bind(i18n);
export default i18n;
