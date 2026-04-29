-- Migration: add reminder_metadata JSON column to message_map
-- 邮件投递后做第二次 LLM 调用，抽取机票/酒店/订单等"应该几点提醒"的事件元数据，
-- 序列化为 JSON 字符串存这里。前端打开提醒页时读这个字段预填表单。
-- NULL = 尚未分析 / LLM 抽取失败 / 邮件无可操作事件（confidence < 0.5）
ALTER TABLE message_map ADD COLUMN reminder_metadata TEXT;
