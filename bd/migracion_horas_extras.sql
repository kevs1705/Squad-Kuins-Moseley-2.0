-- =====================================================================
-- MIGRACIÓN: MÓDULO DE HORAS EXTRAS (BITÁCORA, EVIDENCIA Y DURACIÓN)
-- =====================================================================

ALTER TABLE `notificaciones` 
  ADD COLUMN IF NOT EXISTS `comprobante` VARCHAR(255) NULL AFTER `motivo`,
  ADD COLUMN IF NOT EXISTS `tarea` TEXT NULL AFTER `motivo`,
  ADD COLUMN IF NOT EXISTS `horas_cantidad` DECIMAL(5,2) NULL AFTER `hora_fin`,
  MODIFY COLUMN `hora_fin` TIME NULL,
  MODIFY COLUMN `motivo` TEXT NULL;
