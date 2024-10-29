import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import qs from "qs";
import fs from "fs";
import FormData from "form-data";
import path from "path";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@/utils/supabase/component";

const supabase = createClient();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const config = {
  api: {
    bodyParser: false, // FormData 사용 시 bodyParser 비활성화
  },
};

export async function POST(
  req: NextRequest,
  { params }: { params: { recordingId: string } }
) {
  const { recordingId } = params;

  // Run STT
  try {
    const audioFileBuffer = await downloadWavFile(recordingId);
    const authToken = await getAuthToken();
    const utterances = await getTranscription(authToken, audioFileBuffer);
    console.log("Transcription:", utterances);
    // TODO: Save transcription to DB - Utterances
    return NextResponse.json({
      message: "---- successfully",
      transcription: utterances,
    });
  } catch (error) {
    console.error("--- error:", error);
    return NextResponse.json({ error: "--- failed" }, { status: 500 });
  }
}

// download wav file from S3 and return buffer
async function downloadWavFile(recordingId: string): Promise<Buffer> {
  const downloadParams = {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: `recordings/${recordingId}.wav`,
  };
  const command = new GetObjectCommand(downloadParams);
  const { Body } = await s3Client.send(command);

  const chunks: Uint8Array[] = [];
  const readableStream = Body as ReadableStream;
  const reader = readableStream.getReader();
  let result = await reader.read();
  while (!result.done) {
    chunks.push(result.value);
    result = await reader.read();
  }

  return Buffer.concat(chunks);
}

async function getAuthToken() {
  try {
    const response = await axios.post(
      "https://openapi.vito.ai/v1/authenticate",
      qs.stringify({
        // 데이터를 URL 인코딩해서 전송
        client_id: process.env.RETURNZERO_CLIENT_ID,
        client_secret: process.env.RETURNZERO_CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
      }
    );

    // 응답으로 받은 JWT 토큰 출력
    const token = response.data.access_token;
    return token;
  } catch (error) {
    console.error(
      "Error fetching token:",
      error.response ? error.response.data : error.message
    );
  }
}

async function getTranscription(auth_token: string, audioFileBuffer: Buffer) {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioFileBuffer], { type: "audio/wav" }),
    "recording.wav"
  );
  formData.append(
    "config",
    JSON.stringify({
      model_name: "sommers", // 또는 'whisper'
      use_diarization: true,
      diarization: {
        spk_count: 2,
      },
    })
  );

  try {
    const response = await axios.post(
      "https://openapi.vito.ai/v1/transcribe",
      formData,
      {
        headers: {
          Authorization: `Bearer ${auth_token}`,
          accept: "application/json",
          ...formData.getHeaders(),
        },
      }
    );
    const transcribeId = response.data.id;
    console.log("Transcription request sent:", transcribeId);

    // 전사 결과 조회
    const results = await checkTranscriptionResult(auth_token, transcribeId);
    return results;
  } catch (error) {
    console.error("Error during transcription request:", error);
  }
}

async function checkTranscriptionResult(
  auth_token,
  transcribeId
): Promise<any> {
  try {
    // 일정 시간 대기 (예: 5초)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const response = await axios.get(
      `https://openapi.vito.ai/v1/transcribe/${transcribeId}`,
      {
        headers: {
          Authorization: `Bearer ${auth_token}`,
          accept: "application/json",
        },
      }
    );

    if (response.data.status === "completed") {
      console.log("Transcription completed");
      return response.data.results;
    } else if (response.data.status === "transcribing") {
      console.log("Transcription is still in progress. Retrying...");
      await checkTranscriptionResult(auth_token, transcribeId); // 재귀 호출로 재시도
    } else {
      console.error("Transcription failed:", response.data);
    }
  } catch (error) {
    console.error("Error retrieving transcription result:", error);
  }
}