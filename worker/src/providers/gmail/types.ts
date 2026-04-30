interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPayload[];
}

export interface GmailMessage {
  id: string;
  labelIds?: string[];
  payload?: GmailPayload;
}

export interface GmailMessageList {
  messages?: { id: string }[];
}

export interface GmailWatchResponse {
  historyId?: string;
  expiration?: string;
}

export interface GmailHistoryResponse {
  history?: {
    messagesAdded?: { message: GmailMessage }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

export interface GmailProfile {
  historyId: string;
}
