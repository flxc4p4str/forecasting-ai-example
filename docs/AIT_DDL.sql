-- Oracle 26ai DDL for AI request/response logging
-- Table naming rule: 8 characters, uppercase, starts with AIT.

CREATE TABLE AITREQST (
    AI_REQUEST_NO      VARCHAR2(10)    NOT NULL,
    REQUEST_TS         TIMESTAMP       DEFAULT SYSTIMESTAMP NOT NULL,
    USER_ID            VARCHAR2(30),
    SESSION_NO         VARCHAR2(30),
    CLIENT_ID          VARCHAR2(60),
    ENDPOINT           VARCHAR2(60),
    ACTION_NAME        VARCHAR2(30),
    FORECAST_UPLOAD_ID VARCHAR2(20),
    JOB_ID             NUMBER(10),
    STATUS_CODE        VARCHAR2(20),
    HTTP_STATUS        NUMBER(3),
    OPENAI_RESPONSE_ID VARCHAR2(100),
    OPENAI_MODEL       VARCHAR2(80),
    REQUEST_HASH       VARCHAR2(64),
    FORECAST_TYPE      VARCHAR2(30),
    CACHE_STATUS       VARCHAR2(20)    DEFAULT 'NOT_CHECKED',
    NORMALIZED_PROMPT  CLOB,
    USER_CONTEXT       CLOB,
    REQUEST_JSON       CLOB,
    RESPONSE_JSON      CLOB,
    OUTPUT_TEXT        CLOB,
    SIM_META_JSON      CLOB,
    ERROR_MESSAGE      VARCHAR2(4000),
    PROMPT_TOKENS      NUMBER(10),
    COMPLETION_TOKENS  NUMBER(10),
    TOTAL_TOKENS       NUMBER(10),
    DURATION_MS        NUMBER(12),
    DATE_CREATED       DATE            DEFAULT SYSDATE NOT NULL,
    CREATED_BY         VARCHAR2(30),
    DATE_CHANGED       DATE,
    CHANGED_BY         VARCHAR2(30),
    CONSTRAINT AITREQPK PRIMARY KEY (AI_REQUEST_NO)
);

CREATE SEQUENCE AITREQSQ
    START WITH 1
    INCREMENT BY 1
    NOCACHE
    NOCYCLE;

CREATE INDEX AITREQI1 ON AITREQST (REQUEST_HASH, OPENAI_MODEL);
CREATE INDEX AITREQI2 ON AITREQST (REQUEST_TS);
CREATE INDEX AITREQI3 ON AITREQST (STATUS_CODE, REQUEST_TS);
CREATE INDEX AITREQI4 ON AITREQST (OPENAI_RESPONSE_ID);

COMMENT ON TABLE AITREQST IS 'Stores AI forecast requests, OpenAI request/response JSON, extracted output, usage, errors, and cache-support metadata.';
COMMENT ON COLUMN AITREQST.AI_REQUEST_NO IS 'Application request number. Generated as AI + 8 digit sequence value.';
COMMENT ON COLUMN AITREQST.REQUEST_HASH IS 'SHA-256 hash of normalized request context and forecast payload. Intended for future exact/similar request cache checks.';
COMMENT ON COLUMN AITREQST.NORMALIZED_PROMPT IS 'Normalized text used for hash generation and future similarity matching.';
COMMENT ON COLUMN AITREQST.REQUEST_JSON IS 'Full JSON payload sent to the OpenAI Responses API.';
COMMENT ON COLUMN AITREQST.RESPONSE_JSON IS 'Full JSON payload returned by the OpenAI Responses API.';
COMMENT ON COLUMN AITREQST.OUTPUT_TEXT IS 'Extracted model output text, normally schema-valid JSON.';
COMMENT ON COLUMN AITREQST.SIM_META_JSON IS 'Reserved for future Oracle 26ai vector/similarity metadata. Not used by the initial controller.';
COMMENT ON COLUMN AITREQST.CACHE_STATUS IS 'Reserved for future cache flow. Initial controller writes NOT_CHECKED/default only.';
