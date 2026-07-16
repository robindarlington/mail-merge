/**
 * Barrel for the userId-scoped data-access layer. Web Server Actions and the
 * worker import DAL functions from `@/lib/data` (never reaching for `db` +
 * `schema` directly for tenant-owned reads/writes), so the "every access is
 * userId-scoped" invariant (AUTH-02) lives behind one import surface.
 *
 * lib/data depends on lib/db (the sole SQLite opener, D-04); it never opens the
 * database itself.
 */

export {
  listSmtpConfigsForUser,
  getSmtpConfigByIdForUser,
  createSmtpConfig,
  updateSmtpConfigById,
  setDefaultSmtpConfig,
  softDeleteSmtpConfig,
  countActiveSendsForConfig,
  updateSmtpConfigMeta,
  toSmtpConfigDto,
  type PersistableConfig,
  type SmtpConfigDto,
} from "./smtp";

export {
  createRecipientSet,
  listRecipientSetsForUser,
  getRecipientSetForUser,
  renameRecipientSet,
  setAttachmentColumnForUser,
  countCampaignsForRecipientSet,
  deleteRecipientSetForUser,
  type PersistableRecipientSet,
} from "./recipients";

export {
  createAttachment,
  listPendingAttachmentsForUser,
  deleteAttachmentForUser,
  getAttachmentForUser,
  listAttachmentsForCampaign,
  stampCampaignOnPendingAttachments,
  getAttachmentByIdForCampaign,
  type PersistableAttachment,
} from "./attachments";

export {
  createTemplate,
  listTemplatesForUser,
  getTemplateForUser,
  type PersistableTemplate,
} from "./templates";

export {
  createDraftCampaign,
  getCampaignForUser,
  enqueueCampaign,
  countActiveCampaignsForRecipientSet,
  deleteCampaignForUser,
  listCampaignsForUser,
  getSendRecordsForCampaign,
  getCampaignProgressRow,
  type PersistableCampaign,
  type DeleteCampaignResult,
} from "./campaigns";
