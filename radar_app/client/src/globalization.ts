// русские подписи компонентов Kendo, как globalization.tsx в ggnp.ofd.client (без данных CLDR: форматы чисел и дат
// приложение задаёт само, helpers/format.ts). messages/ru/ru.ts - копия из образца, обновляется целиком
import { loadMessages } from "@progress/kendo-react-intl";

import ruMessages from "./messages/ru/ru";

export const loadRussianMessages = (): string => {
    loadMessages(ruMessages, "ru");
    return "ru";
};
