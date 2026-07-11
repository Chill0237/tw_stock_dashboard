import datetime
import subprocess
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backfill")

def run_backfill():
    start_date = datetime.date(2026, 5, 1)
    end_date = datetime.date(2026, 7, 11)
    
    current_date = start_date
    success_count = 0
    skipped_count = 0

    logger.info(f"=== 開始歷史資料回溯管線 ===")
    logger.info(f"區間：{start_date.strftime('%Y%m%d')} -> {end_date.strftime('%Y%m%d')}")
    logger.info(f"嚴格執行順序：時間正向排序 (舊 -> 新)")
    print("-" * 50)

    while current_date <= end_date:
        # 檢查是否為週末 (5 是週六，6 是週日)
        if current_date.weekday() in [5, 6]:
            logger.info(f"[{current_date.strftime('%Y%m%d')}] 週六/週日，自動跳過。")
            current_date += datetime.timedelta(days=1)
            skipped_count += 1
            continue

        date_str = current_date.strftime("%Y%m%d")
        logger.info(f"🚀 正在執行：{date_str} ...")

        # 組裝指令：python3 -m quant_system_v2.run --date YYYYMMDD
        cmd = [sys.executable, "-m", "quant_system_v2.run", "--date", date_str]
        
        try:
            # 執行子程序，並即時將日誌導向終端機
            result = subprocess.run(cmd, check=True)
            if result.returncode == 0:
                logger.info(f"✅ {date_str} 執行成功。")
                success_count += 1
        except subprocess.CalledProcessError as e:
            logger.error(f"❌ {date_str} 執行失敗！錯誤碼: {e.returncode}")
            logger.error("偵測到管線中斷，為確保歷史資料連續性，立即停止後續回溯！")
            sys.exit(1)
        except Exception as e:
            logger.error(f"💥 未知異常: {e}")
            sys.exit(1)

        print("-" * 50)
        current_date += datetime.timedelta(days=1)

    logger.info(f"=== 回溯歷史完成 ===")
    logger.info(f"成功交易日總數: {success_count} 天")
    logger.info(f"自動跳過週末數: {skipped_count} 天")

if __name__ == "__main__":
    run_backfill()