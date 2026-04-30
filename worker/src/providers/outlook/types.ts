export interface GraphMessage {
  id: string;
  subject?: string;
  parentFolderId?: string;
  flag?: { flagStatus: string };
  from?: { emailAddress?: { name?: string; address?: string } };
}

export interface GraphMessageList {
  value?: GraphMessage[];
}

export interface GraphFolder {
  id: string;
}
