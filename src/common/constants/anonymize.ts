/**
 * Мягкое удаление: строка остаётся ради истории вызовов, персональные данные
 * стираются. Домен общий для самоудаления пользователя и удаления оператора
 * админом — иначе «удалённых» стало бы два разных вида.
 */
export const ANONYMIZE_EMAIL_DOMAIN = 'deleted.local';

export const anonymizedEmailFor = (userId: string) =>
  `deleted_${userId}@${ANONYMIZE_EMAIL_DOMAIN}`;
