-- Migration: add archive_folder_name for human-readable display
-- Gmail 的 archive_folder 存的是 Label ID（如 Label_xxx），用户不可读；
-- 这列额外存一份 label name 用于 UI 展示，归档操作仍然用 archive_folder (ID)。
ALTER TABLE accounts ADD COLUMN archive_folder_name TEXT;
