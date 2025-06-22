import torch
import librosa
from transformers import ClapModel, ClapProcessor

# --- 설정 ---
MODEL_NAME = "laion/clap-htsat-unfused"
DEVICE = "cpu"

try:
    print(f"평가 모델을 로딩합니다: {MODEL_NAME}")
    model = ClapModel.from_pretrained(MODEL_NAME).to(DEVICE)
    processor = ClapProcessor.from_pretrained(MODEL_NAME)
    print("모델 로딩 완료.")
except Exception as e:
    print(f"모델 로딩 중 오류 발생: {e}")
    exit()

def analyze_prompt_effectiveness(original_prompt, augmented_prompt, original_music_path, augmented_music_path):
    """
    프롬프트 증강의 효과를 정량적으로 분석하고 결과를 출력합니다.
    """
    try:
        print("\n--- 분석 시작 ---")
        print(f"오디오 파일을 로딩합니다: {original_music_path}, {augmented_music_path}")
        m_orig, _ = librosa.load(original_music_path, sr=48000, mono=True)
        m_aug, _ = librosa.load(augmented_music_path, sr=48000, mono=True)

        # 텍스트와 오디오를 모델 입력 형식으로 변환
        texts = [original_prompt, augmented_prompt]
        audios = [m_orig, m_aug]
        inputs = processor(text=texts, audios=audios, return_tensors="pt", padding=True, sampling_rate=48000).to(DEVICE)

        with torch.no_grad():
            # 텍스트-오디오 간의 최종 유사도 계산
            outputs = model(**inputs)
            # 최종 결과는 outputs.logits_per_text에 담겨 있습니다.
            # 정규화된 임베딩 간의 코사인 유사도
            similarity_matrix = outputs.logits_per_text
        # ==================================

        # 점수 추출
        score_a = similarity_matrix[0, 0].item() # P_orig (0) <-> M_orig (0)
        score_b = similarity_matrix[0, 1].item() # P_orig (0) <-> M_aug (1)
        score_c = similarity_matrix[1, 1].item() # P_aug (1) <-> M_aug (1)

        # 결과 출력
        print("\n--- 정량 분석 결과 보고서 ---")
        print(f"[입력] 원본 프롬프트: \"{original_prompt}\"")
        print(f"[입력] 증강 프롬프트: \"{augmented_prompt}\"")
        print("-" * 30)
        print(f"A. 원본 음악의 의도 부합도 (P_orig ↔ M_orig): {score_a:.2f}점")
        print(f"B. 증강 음악의 원본 의도 부합도 (P_orig ↔ M_aug): {score_b:.2f}점")
        print(f"C. 증강 음악의 디테일 반영도 (P_aug ↔ M_aug): {score_c:.2f}점")
        print("-" * 30)

        improvement = score_b - score_a
        print("[결론]")
        if improvement > 0:
            print(f"✅ 원본 의도 개선 효과: 증강 후 음악이 원본 의도에 더 부합합니다. (점수 {improvement:+.2f}점 향상)")
        else:
            print(f"❌ 원본 의도 개선 효과: 증강이 원본 의도를 개선하지 못했습니다. (점수 {improvement:+.2f}점)")

        if score_c * 100 > 70: # 임계값은 70점 등으로 조절 가능합니다.
             print(f"✅ 증강 내용 반영 효과: 증강 음악이 추가된 디테일을 성공적으로 반영했습니다. (점수: {score_c:.2f}점)")
        else:
             print(f"⚠️ 증강 내용 반영 효과: 증강 음악이 추가된 디테일을 충분히 반영하지 못했을 수 있습니다. (점수: {score_c:.2f}점)")

    except FileNotFoundError as e:
        print(f"[오류] 오디오 파일을 찾을 수 없습니다. 경로를 확인해주세요: {e.filename}")
    except Exception as e:
        print(f"분석 중 오류가 발생했습니다: {e}")


if __name__ == "__main__":
    p_orig = "오늘 너무 더워서 힘들어..."
    p_aug = "Upbeat Tejano music, accordion melody, driving rhythm, Selena-esque vocals, hot summer day, Converse TX, 120 bpm, major key, energetic, refreshing, David Adickes' sculpture vibe"

    m_orig_path = "ori.mp3"
    m_aug_path = "aug.mp3"

    analyze_prompt_effectiveness(p_orig, p_aug, m_orig_path, m_aug_path)
