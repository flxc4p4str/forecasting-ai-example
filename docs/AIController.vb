Imports Microsoft.AspNetCore.Mvc
Imports Microsoft.AspNetCore.Authorization
Imports System.Data
Imports Microsoft.AspNetCore.Http
Imports Microsoft.AspNetCore.Hosting
Imports System.IO
Imports System.Net
Imports System.Net.Http
Imports System.Net.Http.Headers
Imports System.Text
Imports System.Text.RegularExpressions
Imports System.Threading.Tasks
Imports System.Linq
Imports Microsoft.VisualBasic.FileIO
Imports Newtonsoft.Json
Imports Newtonsoft.Json.Linq
Imports Oracle.ManagedDataAccess.Client
Imports Oracle.ManagedDataAccess.Types

Namespace intapi

    <Route("api/[controller]")>
    Public Class AIController
        Inherits ABSController

        Private ReadOnly _webHostEnvironment As IWebHostEnvironment

        Private Shared ReadOnly httpClient As New HttpClient()
        Private Shared ReadOnly stateLock As New Object()
        Private Shared state As AIForecastState = SeedDemoData()

#Region "Instantiate"
        Public Sub New(EWSsettings As IEWSSettings, JWTsettings As IJWTSettings, ABSSettings As IABSSettings, hostingEnvironment As IWebHostEnvironment, httpContextAccessor As IHttpContextAccessor)
            MyBase.New(EWSsettings, JWTsettings, ABSSettings, hostingEnvironment, httpContextAccessor)
            _webHostEnvironment = hostingEnvironment
        End Sub
#End Region

#Region "Public Procedures"

        ' Keeps compatibility with the current Angular/Express endpoint: GET /api/forecast
        <HttpGet("/api/forecast")>
        Public Function Forecast() As IActionResult
            Try
                Return Ok(ForecastWorkspacePayload())
            Catch ex As Exception
                ERRORS.Add(ex.Message)
                API_Result = New With {.SUCCESS = False, .ERRORS = ERRORS}
                Return StatusCode(500, API_Result)
            End Try
        End Function

        ' Keeps compatibility with the current Angular/Express endpoint: POST /api/forecasts
        ' Expected form field name: forecast_file
        <HttpPost("/api/forecasts")>
        Public Function UploadForecast(<FromForm(Name:="forecast_file")> forecastFile As IFormFile) As IActionResult
            Try
                If forecastFile Is Nothing OrElse forecastFile.Length = 0 Then
                    SyncLock stateLock
                        state.Forecast.status = "failed"
                        state.Forecast.error_message = "CSV upload must include a forecast_file."
                    End SyncLock
                    Return BadRequest(ForecastWorkspacePayload())
                End If

                Dim contents As String
                Using reader As New StreamReader(forecastFile.OpenReadStream(), Encoding.UTF8, True)
                    contents = reader.ReadToEnd()
                End Using

                contents = contents.TrimStart(ChrW(&HFEFF))
                Dim parsedRows As List(Of ParsedForecastRow) = ParseForecastCsv(contents)

                SyncLock stateLock
                    ApplyForecastCsv(parsedRows)
                    ClearAiJobs()
                    state.Forecast.original_filename = If(String.IsNullOrWhiteSpace(forecastFile.FileName), "forecast.csv", forecastFile.FileName)
                    state.Forecast.status = "active"
                    state.Forecast.error_message = Nothing
                End SyncLock

                Return Ok(ForecastWorkspacePayload())

            Catch ex As Exception
                SyncLock stateLock
                    state.Forecast.status = "failed"
                    state.Forecast.error_message = ex.Message
                End SyncLock
                Return BadRequest(ForecastWorkspacePayload())
            End Try
        End Function

        ' Keeps compatibility with the current Angular/Express endpoint: POST /api/ai-jobs
        <HttpPost("/api/ai-jobs")>
        Public Function CreateAIJob(<FromBody> request As AIJobRequest) As IActionResult

            If request Is Nothing Then
                request = New AIJobRequest()
            End If

            Using TryCast(ASCDATA1, IDisposable)
                Try
                    Dim userContext As String = BuildUserContext(request)
                    Dim forecastPayload As JObject = LoadForecastPayload()
                    Dim forecastUploadId As String = forecastPayload.Value(Of String)("forecast_upload_id")
                    Dim model As String = ConfigValue("OPENAI_MODEL", "gpt-5")
                    Dim baseUrl As String = ConfigValue("OPENAI_BASE_URL", "https://api.openai.com/v1").Trim().TrimEnd("/"c)
                    Dim apiKey As String = ConfigValue("OPENAI_API_KEY", "").Trim()
                    Dim demoAIWithoutKey As Boolean = ParseBoolean(ConfigValue("DEMO_AI_WITHOUT_KEY", "true"), True)
                    Dim webSearchTool As String = ConfigValue("OPENAI_WEB_SEARCH_TOOL", "web_search").Trim()
                    Dim promptRoot As String = Path.Combine(_webHostEnvironment.ContentRootPath, "app", "prompts")
                    Dim connectionString As String = ASCDATA1._oracon.ConnectionString
                    Dim requestNo As String = ""

                    Dim job As AIJob
                    SyncLock stateLock
                        ClearAiJobs()
                        job = New AIJob With {
                            .id = state.nextJobId,
                            .forecast_upload_id = CInt(Val(forecastUploadId)),
                            .status = "queued",
                            .error_message = Nothing,
                            .findings = New JObject(),
                            .user_context = userContext,
                            .created_at = DateTime.UtcNow.ToString("o")
                        }
                        state.nextJobId += 1
                        state.Jobs(job.id) = job
                    End SyncLock

                    Dim normalizedPrompt As String = NormalizeForHash(userContext & vbLf & forecastPayload.ToString(Formatting.None))
                    Dim requestHash As String = Sha256Hex(normalizedPrompt)

                    requestNo = InsertAIRequest(
                        ASCDATA1._oracon,
                        ASCDATA1.USER_ID,
                        ASCDATA1.SESSION_NO,
                        job.id,
                        forecastUploadId,
                        userContext,
                        normalizedPrompt,
                        requestHash,
                        model,
                        "QUEUED",
                        Nothing,
                        Nothing,
                        Nothing,
                        Nothing,
                        Nothing,
                        Nothing,
                        Nothing,
                        Nothing)

                    Dim workItem As New AIBackgroundWorkItem With {
                        .JobId = job.id,
                        .AIRequestNo = requestNo,
                        .ForecastPayload = forecastPayload,
                        .UserContext = userContext,
                        .OpenAIAPIKey = apiKey,
                        .OpenAIModel = model,
                        .OpenAIBaseUrl = baseUrl,
                        .DemoAIWithoutKey = demoAIWithoutKey,
                        .OpenAIWebSearchTool = webSearchTool,
                        .PromptRoot = promptRoot,
                        .OracleConnectionString = connectionString
                    }

                    Task.Run(Async Function()
                                 Await RunAIJobAsync(workItem)
                             End Function)

                    Return Ok(AIJobPayload(job))

                Catch ex As Exception
                    ERRORS.Add(ex.Message)
                    API_Result = New With {.SUCCESS = False, .ERRORS = ERRORS}
                    Return StatusCode(500, API_Result)
                End Try
            End Using
        End Function

        ' Keeps compatibility with the current Angular/Express endpoint: GET /api/ai-jobs/:jobId
        <HttpGet("/api/ai-jobs/{jobId}")>
        Public Function GetAIJob(jobId As Integer) As IActionResult
            Try
                Dim job As AIJob = Nothing
                SyncLock stateLock
                    If state.Jobs.ContainsKey(jobId) Then
                        job = state.Jobs(jobId)
                    End If
                End SyncLock

                If job Is Nothing Then
                    Return NotFound(New With {.detail = "AI job not found"})
                End If

                Return Ok(AIJobPayload(job))

            Catch ex As Exception
                ERRORS.Add(ex.Message)
                API_Result = New With {.SUCCESS = False, .ERRORS = ERRORS}
                Return StatusCode(500, API_Result)
            End Try
        End Function

        ' Keeps compatibility with the current Angular/Express endpoint: GET /forecasts/template.csv
        <HttpGet("/forecasts/template.csv")>
        Public Function ForecastTemplateCsvDownload() As IActionResult
            Dim csv As String = ForecastTemplateCsv()
            Dim bytes() As Byte = Encoding.UTF8.GetBytes(csv)
            Return File(bytes, "text/csv; charset=utf-8", "forecast-template.csv")
        End Function

#End Region

#Region "AI Job Processing"

        Private Shared Async Function RunAIJobAsync(workItem As AIBackgroundWorkItem) As Task
            Dim startedAt As DateTime = DateTime.UtcNow
            Dim requestJson As String = ""
            Dim responseJson As String = ""
            Dim outputText As String = ""
            Dim openAIResponseId As String = ""
            Dim httpStatus As Integer? = Nothing
            Dim promptTokens As Integer? = Nothing
            Dim completionTokens As Integer? = Nothing
            Dim totalTokens As Integer? = Nothing

            Try
                SetJobRunning(workItem.JobId)
                UpdateAIRequestStatus(workItem.OracleConnectionString, workItem.AIRequestNo, "RUNNING", Nothing, Nothing, Nothing, Nothing, Nothing, Nothing, Nothing, Nothing)

                Dim findingsPayload As JObject

                If Not String.IsNullOrWhiteSpace(workItem.OpenAIAPIKey) Then
                    Dim result As OpenAIResult = Await RequestOpenAIFindings(workItem)
                    requestJson = result.RequestJson
                    responseJson = result.ResponseJson
                    outputText = result.OutputText
                    openAIResponseId = result.ResponseId
                    httpStatus = result.HttpStatus
                    promptTokens = result.PromptTokens
                    completionTokens = result.CompletionTokens
                    totalTokens = result.TotalTokens

                    Dim parsedFindings As List(Of AIFinding) = ParseAIResponse(JObject.Parse(outputText))
                    findingsPayload = FindingsToPayload(parsedFindings)
                ElseIf workItem.DemoAIWithoutKey Then
                    findingsPayload = DemoFindingPayload()
                    outputText = findingsPayload.ToString(Formatting.None)
                    responseJson = JObject.FromObject(New With {.demo = True, .findings = findingsPayload}).ToString(Formatting.None)
                    httpStatus = 200
                Else
                    Throw New Exception("OPENAI_API_KEY is required to run AI analysis.")
                End If

                SetJobCompleted(workItem.JobId, openAIResponseId, findingsPayload)

                Dim durationMs As Integer = CInt(DateTime.UtcNow.Subtract(startedAt).TotalMilliseconds)
                UpdateAIRequestStatus(
                    workItem.OracleConnectionString,
                    workItem.AIRequestNo,
                    "COMPLETED",
                    httpStatus,
                    openAIResponseId,
                    requestJson,
                    responseJson,
                    outputText,
                    Nothing,
                    durationMs,
                    promptTokens,
                    completionTokens,
                    totalTokens)

            Catch ex As Exception
                SetJobFailed(workItem.JobId, ex.Message)
                Dim durationMs As Integer = CInt(DateTime.UtcNow.Subtract(startedAt).TotalMilliseconds)
                UpdateAIRequestStatus(
                    workItem.OracleConnectionString,
                    workItem.AIRequestNo,
                    "FAILED",
                    httpStatus,
                    openAIResponseId,
                    requestJson,
                    responseJson,
                    outputText,
                    ex.Message,
                    durationMs,
                    promptTokens,
                    completionTokens,
                    totalTokens)
            End Try
        End Function

        Private Shared Async Function RequestOpenAIFindings(workItem As AIBackgroundWorkItem) As Task(Of OpenAIResult)
            Dim requestBody As JObject = BuildOpenAIRequestBody(workItem)
            Dim requestJson As String = requestBody.ToString(Formatting.None)
            Dim initialResponse As OpenAIHttpResponse = Await OpenAIRequest(workItem, "/responses", HttpMethod.Post, requestJson)

            Dim completedResponse As OpenAIHttpResponse = Await WaitForOpenAIResponse(workItem, initialResponse.Payload)
            Dim outputText As String = ExtractOutputText(completedResponse.Payload)

            If String.IsNullOrWhiteSpace(outputText) Then
                Throw New Exception("OpenAI response did not include output text.")
            End If

            Dim usage As JObject = TryCast(completedResponse.Payload("usage"), JObject)

            Return New OpenAIResult With {
                .RequestJson = requestJson,
                .ResponseJson = completedResponse.ResponseJson,
                .OutputText = outputText,
                .ResponseId = completedResponse.Payload.Value(Of String)("id"),
                .HttpStatus = completedResponse.StatusCode,
                .PromptTokens = NullableInt(usage, "input_tokens"),
                .CompletionTokens = NullableInt(usage, "output_tokens"),
                .TotalTokens = NullableInt(usage, "total_tokens")
            }
        End Function

        Private Shared Async Function WaitForOpenAIResponse(workItem As AIBackgroundWorkItem, initialResponse As JObject) As Task(Of OpenAIHttpResponse)
            Dim currentPayload As JObject = initialResponse
            Dim responseId As String = currentPayload.Value(Of String)("id")

            If String.IsNullOrWhiteSpace(responseId) Then
                Throw New Exception("OpenAI response did not include an id.")
            End If

            Dim deadline As DateTime = DateTime.UtcNow.AddMinutes(4)
            Dim currentStatus As String = (currentPayload.Value(Of String)("status") & "").ToLowerInvariant()
            Dim currentHttpResponse As New OpenAIHttpResponse With {.Payload = currentPayload, .ResponseJson = currentPayload.ToString(Formatting.None), .StatusCode = 200}

            While currentStatus = "queued" OrElse currentStatus = "in_progress" OrElse currentStatus = "running"
                If DateTime.UtcNow > deadline Then
                    Throw New Exception("OpenAI response polling timed out.")
                End If

                Await Task.Delay(2000)
                currentHttpResponse = Await OpenAIRequest(workItem, "/responses/" & Uri.EscapeDataString(responseId), HttpMethod.Get, Nothing)
                currentPayload = currentHttpResponse.Payload
                currentStatus = (currentPayload.Value(Of String)("status") & "").ToLowerInvariant()
            End While

            If currentStatus <> "completed" Then
                Dim err As String = OpenAIResponseError(currentPayload)
                If String.IsNullOrWhiteSpace(err) Then
                    err = "OpenAI response ended with status " & currentStatus & "."
                End If
                Throw New Exception(err)
            End If

            Return currentHttpResponse
        End Function

        Private Shared Async Function OpenAIRequest(workItem As AIBackgroundWorkItem, pathname As String, method As HttpMethod, requestJson As String) As Task(Of OpenAIHttpResponse)
            Dim url As String = workItem.OpenAIBaseUrl.TrimEnd("/"c) & pathname

            Using request As New HttpRequestMessage(method, url)
                request.Headers.Authorization = New AuthenticationHeaderValue("Bearer", workItem.OpenAIAPIKey)

                If requestJson IsNot Nothing Then
                    request.Content = New StringContent(requestJson, Encoding.UTF8, "application/json")
                End If

                Using response As HttpResponseMessage = Await httpClient.SendAsync(request)
                    Dim responseText As String = Await response.Content.ReadAsStringAsync()
                    Dim payload As JObject = Nothing

                    If Not String.IsNullOrWhiteSpace(responseText) Then
                        Try
                            payload = JObject.Parse(responseText)
                        Catch
                            payload = New JObject(New JProperty("raw", responseText))
                        End Try
                    Else
                        payload = New JObject()
                    End If

                    If Not response.IsSuccessStatusCode Then
                        Dim message As String = "OpenAI request failed with status " & CInt(response.StatusCode).ToString() & "."
                        Dim err As JToken = payload.SelectToken("error.message")
                        If err IsNot Nothing AndAlso Not String.IsNullOrWhiteSpace(err.ToString()) Then
                            message = err.ToString()
                        End If
                        Throw New OpenAIRequestException(message, CInt(response.StatusCode), responseText)
                    End If

                    Return New OpenAIHttpResponse With {.StatusCode = CInt(response.StatusCode), .ResponseJson = responseText, .Payload = payload}
                End Using
            End Using
        End Function

#End Region

#Region "Database Logging"

        Private Shared Function InsertAIRequest(
            oraCon As OracleConnection,
            userId As String,
            sessionNo As String,
            jobId As Integer,
            forecastUploadId As String,
            userContext As String,
            normalizedPrompt As String,
            requestHash As String,
            model As String,
            statusCode As String,
            httpStatus As Integer?,
            openAIResponseId As String,
            requestJson As String,
            responseJson As String,
            outputText As String,
            errorMessage As String,
            durationMs As Integer?) As String

            EnsureConnectionOpen(oraCon)

            Dim requestNo As String = ""
            Using seqCmd As New OracleCommand("SELECT 'AI' || LPAD(AITREQSQ.NEXTVAL, 8, '0') FROM DUAL", oraCon)
                requestNo = CStr(seqCmd.ExecuteScalar())
            End Using

            Dim sql As String = "INSERT INTO AITREQST (" &
                "AI_REQUEST_NO, REQUEST_TS, USER_ID, SESSION_NO, ENDPOINT, ACTION_NAME, FORECAST_UPLOAD_ID, JOB_ID, " &
                "STATUS_CODE, HTTP_STATUS, OPENAI_RESPONSE_ID, OPENAI_MODEL, REQUEST_HASH, NORMALIZED_PROMPT, USER_CONTEXT, " &
                "REQUEST_JSON, RESPONSE_JSON, OUTPUT_TEXT, ERROR_MESSAGE, DURATION_MS, DATE_CREATED, CREATED_BY" &
                ") VALUES (" &
                ":AI_REQUEST_NO, SYSTIMESTAMP, :USER_ID, :SESSION_NO, :ENDPOINT, :ACTION_NAME, :FORECAST_UPLOAD_ID, :JOB_ID, " &
                ":STATUS_CODE, :HTTP_STATUS, :OPENAI_RESPONSE_ID, :OPENAI_MODEL, :REQUEST_HASH, :NORMALIZED_PROMPT, :USER_CONTEXT, " &
                ":REQUEST_JSON, :RESPONSE_JSON, :OUTPUT_TEXT, :ERROR_MESSAGE, :DURATION_MS, SYSDATE, :CREATED_BY)"

            Using cmd As New OracleCommand(sql, oraCon)
                cmd.BindByName = True
                AddVarchar(cmd, "AI_REQUEST_NO", requestNo, 10)
                AddVarchar(cmd, "USER_ID", userId, 30)
                AddVarchar(cmd, "SESSION_NO", sessionNo, 30)
                AddVarchar(cmd, "ENDPOINT", "/api/ai-jobs", 60)
                AddVarchar(cmd, "ACTION_NAME", "FORECAST", 30)
                AddVarchar(cmd, "FORECAST_UPLOAD_ID", forecastUploadId, 20)
                AddNumber(cmd, "JOB_ID", jobId)
                AddVarchar(cmd, "STATUS_CODE", statusCode, 20)
                AddNumber(cmd, "HTTP_STATUS", httpStatus)
                AddVarchar(cmd, "OPENAI_RESPONSE_ID", openAIResponseId, 100)
                AddVarchar(cmd, "OPENAI_MODEL", model, 80)
                AddVarchar(cmd, "REQUEST_HASH", requestHash, 64)
                AddClob(cmd, "NORMALIZED_PROMPT", normalizedPrompt)
                AddClob(cmd, "USER_CONTEXT", userContext)
                AddClob(cmd, "REQUEST_JSON", requestJson)
                AddClob(cmd, "RESPONSE_JSON", responseJson)
                AddClob(cmd, "OUTPUT_TEXT", outputText)
                AddVarchar(cmd, "ERROR_MESSAGE", errorMessage, 4000)
                AddNumber(cmd, "DURATION_MS", durationMs)
                AddVarchar(cmd, "CREATED_BY", If(String.IsNullOrWhiteSpace(userId), "API", userId), 30)
                cmd.ExecuteNonQuery()
            End Using

            Return requestNo
        End Function

        Private Shared Sub UpdateAIRequestStatus(
            connectionString As String,
            requestNo As String,
            statusCode As String,
            httpStatus As Integer?,
            openAIResponseId As String,
            requestJson As String,
            responseJson As String,
            outputText As String,
            errorMessage As String,
            durationMs As Integer?,
            promptTokens As Integer?,
            completionTokens As Integer?,
            totalTokens As Integer?)

            If String.IsNullOrWhiteSpace(requestNo) OrElse String.IsNullOrWhiteSpace(connectionString) Then
                Return
            End If

            Using oraCon As New OracleConnection(connectionString)
                oraCon.Open()
                Dim sql As String = "UPDATE AITREQST SET " &
                    "STATUS_CODE = :STATUS_CODE, HTTP_STATUS = :HTTP_STATUS, OPENAI_RESPONSE_ID = :OPENAI_RESPONSE_ID, " &
                    "REQUEST_JSON = :REQUEST_JSON, RESPONSE_JSON = :RESPONSE_JSON, " &
                    "OUTPUT_TEXT = :OUTPUT_TEXT, ERROR_MESSAGE = :ERROR_MESSAGE, DURATION_MS = :DURATION_MS, " &
                    "PROMPT_TOKENS = :PROMPT_TOKENS, COMPLETION_TOKENS = :COMPLETION_TOKENS, TOTAL_TOKENS = :TOTAL_TOKENS, " &
                    "DATE_CHANGED = SYSDATE, CHANGED_BY = :CHANGED_BY " &
                    "WHERE AI_REQUEST_NO = :AI_REQUEST_NO"

                Using cmd As New OracleCommand(sql, oraCon)
                    cmd.BindByName = True
                    AddVarchar(cmd, "STATUS_CODE", statusCode, 20)
                    AddNumber(cmd, "HTTP_STATUS", httpStatus)
                    AddVarchar(cmd, "OPENAI_RESPONSE_ID", openAIResponseId, 100)
                    AddClob(cmd, "REQUEST_JSON", requestJson)
                    AddClob(cmd, "RESPONSE_JSON", responseJson)
                    AddClob(cmd, "OUTPUT_TEXT", outputText)
                    AddVarchar(cmd, "ERROR_MESSAGE", errorMessage, 4000)
                    AddNumber(cmd, "DURATION_MS", durationMs)
                    AddNumber(cmd, "PROMPT_TOKENS", promptTokens)
                    AddNumber(cmd, "COMPLETION_TOKENS", completionTokens)
                    AddNumber(cmd, "TOTAL_TOKENS", totalTokens)
                    AddVarchar(cmd, "CHANGED_BY", "API", 30)
                    AddVarchar(cmd, "AI_REQUEST_NO", requestNo, 10)
                    cmd.ExecuteNonQuery()
                End Using
            End Using
        End Sub

        Private Shared Sub EnsureConnectionOpen(oraCon As OracleConnection)
            If oraCon Is Nothing Then
                Throw New Exception("Oracle connection is not available.")
            End If
            If oraCon.State <> ConnectionState.Open Then
                oraCon.Open()
            End If
        End Sub

        Private Shared Sub AddVarchar(cmd As OracleCommand, name As String, value As String, size As Integer)
            Dim p As New OracleParameter(name, OracleDbType.Varchar2, size)
            p.Direction = ParameterDirection.Input
            p.Value = If(String.IsNullOrEmpty(value), CType(DBNull.Value, Object), value)
            cmd.Parameters.Add(p)
        End Sub

        Private Shared Sub AddClob(cmd As OracleCommand, name As String, value As String)
            Dim p As New OracleParameter(name, OracleDbType.Clob)
            p.Direction = ParameterDirection.Input
            p.Value = If(String.IsNullOrEmpty(value), CType(DBNull.Value, Object), value)
            cmd.Parameters.Add(p)
        End Sub

        Private Shared Sub AddNumber(cmd As OracleCommand, name As String, value As Integer?)
            Dim p As New OracleParameter(name, OracleDbType.Int32)
            p.Direction = ParameterDirection.Input
            p.Value = If(value.HasValue, CType(value.Value, Object), CType(DBNull.Value, Object))
            cmd.Parameters.Add(p)
        End Sub

        Private Shared Sub AddNumber(cmd As OracleCommand, name As String, value As Long?)
            Dim p As New OracleParameter(name, OracleDbType.Int64)
            p.Direction = ParameterDirection.Input
            p.Value = If(value.HasValue, CType(value.Value, Object), CType(DBNull.Value, Object))
            cmd.Parameters.Add(p)
        End Sub

#End Region

#Region "Payload Builders"

        Private Shared Function ForecastWorkspacePayload() As Object
            SyncLock stateLock
                Return New With {
                    .forecast = state.Forecast,
                    .months = CurrentMonths(),
                    .products = ChartPayload(),
                    .values_by_product = ValuesByProduct(),
                    .findings = CompletedFindingPayload()
                }
            End SyncLock
        End Function

        Private Shared Function ValuesByProduct() As JObject
            Dim result As New JObject()
            For Each product As AIProduct In state.Products
                result(product.id.ToString()) = JObject.FromObject(product.forecast_values)
            Next
            Return result
        End Function

        Private Shared Function ChartPayload() As JArray
            Dim months As List(Of String) = CurrentMonths()
            Dim arr As New JArray()

            For Each product As AIProduct In state.Products
                Dim thisYearForecast As New JArray()
                Dim lastYearForecast As New JArray()
                Dim lastYearActual As New JArray()

                For Each month As String In months
                    thisYearForecast.Add(ValueOrZero(product.forecast_values, month))
                    lastYearForecast.Add(ValueOrZero(product.historical_forecasts, SameMonthLastYear(month)))
                    lastYearActual.Add(ValueOrZero(product.actual_shipments, SameMonthLastYear(month)))
                Next

                arr.Add(New JObject(
                    New JProperty("dbId", product.id),
                    New JProperty("itemCode", product.item_code),
                    New JProperty("label", product.product_name),
                    New JProperty("profile", New JObject(
                        New JProperty("brand", product.brand),
                        New JProperty("type", product.product_type),
                        New JProperty("description", product.description),
                        New JProperty("retailPrice", FormatCurrency(product.retail_price)),
                        New JProperty("itemCode", product.item_code)
                    )),
                    New JProperty("thisYearForecast", thisYearForecast),
                    New JProperty("lastYearForecast", lastYearForecast),
                    New JProperty("lastYearActual", lastYearActual)
                ))
            Next

            Return arr
        End Function

        Private Shared Function CompletedFindingPayload() As JObject
            For Each job As AIJob In state.Jobs.Values
                If job.status = "completed" Then
                    Return job.findings
                End If
            Next
            Return New JObject()
        End Function

        Private Shared Function LoadForecastPayload() As JObject
            SyncLock stateLock
                Dim months As List(Of String) = CurrentMonths()
                Dim products As New JArray()

                For Each product As AIProduct In state.Products
                    Dim forecastUnits As New JObject()
                    Dim lastYearActualUnits As New JObject()
                    Dim lastYearForecastUnits As New JObject()

                    For Each month As String In months
                        forecastUnits(month) = ValueOrZero(product.forecast_values, month)
                        lastYearActualUnits(month) = ValueOrZero(product.actual_shipments, SameMonthLastYear(month))
                        lastYearForecastUnits(month) = ValueOrZero(product.historical_forecasts, SameMonthLastYear(month))
                    Next

                    products.Add(New JObject(
                        New JProperty("product_id", product.item_code),
                        New JProperty("product_name", product.product_name),
                        New JProperty("brand", product.brand),
                        New JProperty("type", product.product_type),
                        New JProperty("description", product.description),
                        New JProperty("retail_price", product.retail_price),
                        New JProperty("forecast_units", forecastUnits),
                        New JProperty("last_year_actual_units", lastYearActualUnits),
                        New JProperty("last_year_forecast_units", lastYearForecastUnits)
                    ))
                Next

                Return New JObject(
                    New JProperty("forecast_upload_id", state.Forecast.id.ToString()),
                    New JProperty("products", products)
                )
            End SyncLock
        End Function

        Private Shared Function AIJobPayload(job As AIJob) As Object
            Dim findings As JObject = If(job.status = "completed", job.findings, New JObject())
            Return New With {
                .id = job.id,
                .status = job.status,
                .forecast_upload_id = job.forecast_upload_id,
                .error_message = job.error_message,
                .findings_count = CountFindings(findings),
                .findings = findings
            }
        End Function

        Private Shared Function BuildOpenAIRequestBody(workItem As AIBackgroundWorkItem) As JObject
            Dim systemPrompt As String = LoadPrompt(workItem.PromptRoot, "ai_researcher.md", DefaultAIResearcherPrompt())
            Dim recommendationPolicy As String = LoadPrompt(workItem.PromptRoot, "recommendation_policy.md", DefaultRecommendationPolicyPrompt())

            Dim userPayload As New JObject(
                New JProperty("forecast", workItem.ForecastPayload),
                New JProperty("customer_context", New JObject(
                    New JProperty("business_type", "ERP customer planning sell-through support for specialty beauty, fragrance, department-store, and boutique retail accounts."),
                    New JProperty("market", "United States demo market unless the user context narrows the geography."),
                    New JProperty("provided_notes", If(String.IsNullOrWhiteSpace(workItem.UserContext), "No customer-specific notes provided.", workItem.UserContext))
                )),
                New JProperty("user_context", workItem.UserContext),
                New JProperty("impact_scale", "-3 to +3, where negative means downward pressure on unit demand."),
                New JProperty("recommendation_policy", recommendationPolicy),
                New JProperty("quality_bar", "Prefer no finding over a generic one. Each finding should name a concrete market signal, season, cultural moment, or product-specific angle.")
            )

            Return New JObject(
                New JProperty("model", workItem.OpenAIModel),
                New JProperty("background", True),
                New JProperty("tools", New JArray(New JObject(New JProperty("type", workItem.OpenAIWebSearchTool)))),
                New JProperty("text", New JObject(
                    New JProperty("format", New JObject(
                        New JProperty("type", "json_schema"),
                        New JProperty("name", "forecast_ai_findings"),
                        New JProperty("strict", True),
                        New JProperty("schema", ForecastAnalysisSchema())
                    ))
                )),
                New JProperty("input", New JArray(
                    New JObject(New JProperty("role", "system"), New JProperty("content", systemPrompt)),
                    New JObject(New JProperty("role", "user"), New JProperty("content", userPayload.ToString(Formatting.None)))
                ))
            )
        End Function

        Private Shared Function ForecastAnalysisSchema() As JObject
            Dim impactSchema As New JObject(
                New JProperty("type", "integer"),
                New JProperty("minimum", -3),
                New JProperty("maximum", 3)
            )

            Dim findingItemSchema As New JObject(
                New JProperty("type", "object"),
                New JProperty("additionalProperties", False),
                New JProperty("required", New JArray("description", "impact")),
                New JProperty("properties", New JObject(
                    New JProperty("description", New JObject(New JProperty("type", "string"))),
                    New JProperty("impact", impactSchema)
                ))
            )

            Dim findingSchema As New JObject(
                New JProperty("type", "object"),
                New JProperty("additionalProperties", False),
                New JProperty("required", New JArray("product_id", "month_year", "considerations", "recommendations")),
                New JProperty("properties", New JObject(
                    New JProperty("product_id", New JObject(New JProperty("type", "string"))),
                    New JProperty("month_year", New JObject(New JProperty("type", "string"), New JProperty("pattern", "^\d{4}-\d{2}$"))),
                    New JProperty("considerations", New JObject(New JProperty("type", "array"), New JProperty("items", findingItemSchema))),
                    New JProperty("recommendations", New JObject(New JProperty("type", "array"), New JProperty("items", findingItemSchema.DeepClone())))
                ))
            )

            Return New JObject(
                New JProperty("type", "object"),
                New JProperty("additionalProperties", False),
                New JProperty("required", New JArray("findings")),
                New JProperty("properties", New JObject(
                    New JProperty("findings", New JObject(
                        New JProperty("type", "array"),
                        New JProperty("items", findingSchema)
                    ))
                ))
            )
        End Function

#End Region

#Region "CSV Handling"

        Private Shared Function ParseForecastCsv(contents As String) As List(Of ParsedForecastRow)
            Dim rows As New List(Of String())()

            Using reader As New StringReader(contents)
                Using parser As New TextFieldParser(reader)
                    parser.TextFieldType = FieldType.Delimited
                    parser.SetDelimiters(",")
                    parser.HasFieldsEnclosedInQuotes = True
                    parser.TrimWhiteSpace = False

                    While Not parser.EndOfData
                        rows.Add(parser.ReadFields())
                    End While
                End Using
            End Using

            If rows.Count = 0 Then
                Throw New Exception("CSV must include a header row.")
            End If

            Dim fieldNames As String() = rows(0).Select(Function(field) (field & "").Trim()).ToArray()
            Dim itemCodeIndex As Integer = Array.IndexOf(fieldNames, "item_code")
            If itemCodeIndex < 0 Then
                Throw New Exception("CSV must include an item_code column.")
            End If

            Dim monthIndexes As New List(Of MonthIndex)()
            For i As Integer = 0 To fieldNames.Length - 1
                If Regex.IsMatch(fieldNames(i), "^\d{4}-\d{2}$") Then
                    monthIndexes.Add(New MonthIndex With {.Field = fieldNames(i), .Index = i})
                End If
            Next

            If monthIndexes.Count = 0 Then
                Throw New Exception("CSV must include at least one month column in YYYY-MM format.")
            End If

            Dim seen As New HashSet(Of String)(StringComparer.OrdinalIgnoreCase)
            Dim result As New List(Of ParsedForecastRow)()

            For rowIndex As Integer = 1 To rows.Count - 1
                Dim row As String() = rows(rowIndex)
                Dim rowNumber As Integer = rowIndex + 1
                Dim itemCode As String = SafeCsvValue(row, itemCodeIndex).Trim()

                If String.IsNullOrWhiteSpace(itemCode) Then
                    Throw New Exception("Row " & rowNumber.ToString() & " is missing item_code.")
                End If

                If seen.Contains(itemCode) Then
                    Throw New Exception("Duplicate item_code '" & itemCode & "'.")
                End If
                seen.Add(itemCode)

                Dim values As New Dictionary(Of String, Integer)(StringComparer.OrdinalIgnoreCase)
                For Each mi As MonthIndex In monthIndexes
                    Dim rawValue As String = SafeCsvValue(row, mi.Index).Trim()
                    If rawValue = "" Then
                        Throw New Exception("Row " & rowNumber.ToString() & " is missing value for " & mi.Field & ".")
                    End If

                    Dim rawNoCommas As String = rawValue.Replace(",", "")
                    Dim units As Integer
                    If Not Regex.IsMatch(rawValue, "^-?\d[\d,]*$") OrElse Not Integer.TryParse(rawNoCommas, units) Then
                        Throw New Exception("Row " & rowNumber.ToString() & " has non-integer value '" & rawValue & "' for " & mi.Field & ".")
                    End If

                    If units < 0 Then
                        Throw New Exception("Row " & rowNumber.ToString() & " has negative forecast units for " & mi.Field & ".")
                    End If

                    values(mi.Field) = units
                Next

                result.Add(New ParsedForecastRow With {.ItemCode = itemCode, .Values = values})
            Next

            If result.Count = 0 Then
                Throw New Exception("CSV must include at least one forecast row.")
            End If

            Return result
        End Function

        Private Shared Sub ApplyForecastCsv(parsedRows As List(Of ParsedForecastRow))
            Dim productsByCode As Dictionary(Of String, AIProduct) = state.Products.ToDictionary(Function(p) p.item_code, Function(p) p, StringComparer.OrdinalIgnoreCase)

            For Each parsed As ParsedForecastRow In parsedRows
                If Not productsByCode.ContainsKey(parsed.ItemCode) Then
                    Throw New Exception("Unknown item_code '" & parsed.ItemCode & "'; forecast CSVs can only update existing ERP products.")
                End If

                Dim product As AIProduct = productsByCode(parsed.ItemCode)
                For Each kvp As KeyValuePair(Of String, Integer) In parsed.Values
                    product.forecast_values(kvp.Key) = kvp.Value
                Next
            Next
        End Sub

#End Region

#Region "Parsing AI Output"

        Private Shared Function ParseAIResponse(payload As JObject) As List(Of AIFinding)
            Dim result As New List(Of AIFinding)()
            Dim findings As JArray = TryCast(payload("findings"), JArray)
            If findings Is Nothing Then
                Return result
            End If

            For Each item As JObject In findings.OfType(Of JObject)()
                Dim finding As New AIFinding With {
                    .ProductId = item.Value(Of String)("product_id"),
                    .MonthYear = item.Value(Of String)("month_year"),
                    .Considerations = ParseAIItems(TryCast(item("considerations"), JArray)),
                    .Recommendations = ParseAIItems(TryCast(item("recommendations"), JArray))
                }
                result.Add(finding)
            Next

            Return result
        End Function

        Private Shared Function ParseAIItems(items As JArray) As List(Of AIFindingItem)
            Dim result As New List(Of AIFindingItem)()
            If items Is Nothing Then
                Return result
            End If

            For Each item As JObject In items.OfType(Of JObject)()
                Dim description As String = item.Value(Of String)("description") & ""
                If String.IsNullOrWhiteSpace(description) Then
                    Continue For
                End If

                Dim impact As Integer = item.Value(Of Integer?)("impact").GetValueOrDefault(0)
                If impact < -3 OrElse impact > 3 Then
                    Throw New Exception("Impact must be between -3 and +3.")
                End If

                result.Add(New AIFindingItem With {.Description = description, .Impact = impact})
            Next

            Return result
        End Function

        Private Shared Function FindingsToPayload(findings As List(Of AIFinding)) As JObject
            Dim productsByCode As Dictionary(Of String, AIProduct) = state.Products.ToDictionary(Function(p) p.item_code, Function(p) p, StringComparer.OrdinalIgnoreCase)
            Dim payload As New JObject()

            For Each finding As AIFinding In findings
                If String.IsNullOrWhiteSpace(finding.ProductId) OrElse Not productsByCode.ContainsKey(finding.ProductId) Then
                    Continue For
                End If

                Dim product As AIProduct = productsByCode(finding.ProductId)
                If String.IsNullOrWhiteSpace(finding.MonthYear) OrElse Not product.forecast_values.ContainsKey(finding.MonthYear) Then
                    Continue For
                End If

                Dim monthFindings As New JArray()
                For Each item As AIFindingItem In finding.Considerations
                    monthFindings.Add(New JObject(New JProperty("type", "consideration"), New JProperty("description", item.Description), New JProperty("impact", item.Impact)))
                Next
                For Each item As AIFindingItem In finding.Recommendations
                    monthFindings.Add(New JObject(New JProperty("type", "recommendation"), New JProperty("description", item.Description), New JProperty("impact", item.Impact)))
                Next

                If monthFindings.Count = 0 Then
                    Continue For
                End If

                Dim productKey As String = product.id.ToString()
                If payload(productKey) Is Nothing Then
                    payload(productKey) = New JObject()
                End If

                CType(payload(productKey), JObject)(finding.MonthYear) = monthFindings
            Next

            Return payload
        End Function

#End Region

#Region "Demo Data"

        Private Shared Function SeedDemoData(Optional today As DateTime? = Nothing) As AIForecastState
            Dim basisDate As DateTime = If(today.HasValue, today.Value, DateTime.Now)
            Dim months As List(Of String) = CurrentMonths(12, basisDate)
            Dim seededProducts As List(Of AIProductSeed) = ProductSeeds()
            Dim products As New List(Of AIProduct)()

            For index As Integer = 0 To seededProducts.Count - 1
                Dim seed As AIProductSeed = seededProducts(index)
                Dim forecastValues As New Dictionary(Of String, Integer)(StringComparer.OrdinalIgnoreCase)
                Dim actualShipments As New Dictionary(Of String, Integer)(StringComparer.OrdinalIgnoreCase)
                Dim historicalForecasts As New Dictionary(Of String, Integer)(StringComparer.OrdinalIgnoreCase)

                For monthIndex As Integer = 0 To months.Count - 1
                    Dim monthYear As String = months(monthIndex)
                    Dim monthNumber As Integer = CInt(monthYear.Substring(5, 2))
                    Dim seasonal As Decimal = SeasonalMultiplier(monthNumber, seed.PromoMonths)
                    Dim lastYearMonth As String = SameMonthLastYear(monthYear)
                    Dim lastYearActual As Integer = CInt(Math.Truncate(seed.BaseUnits * seasonal * CDec(0.94 + monthIndex * 0.006)))
                    Dim lastYearForecast As Integer = CInt(Math.Truncate(lastYearActual * CDec(0.96 + ((index + monthIndex) Mod 5) * 0.018)))
                    Dim thisYearForecast As Integer = CInt(Math.Truncate(lastYearActual * seed.Trend * CDec(1.0 + ((monthIndex Mod 4) - 1.5) * 0.018)))

                    forecastValues(monthYear) = thisYearForecast
                    actualShipments(lastYearMonth) = lastYearActual
                    historicalForecasts(lastYearMonth) = lastYearForecast
                Next

                products.Add(New AIProduct With {
                    .id = index + 1,
                    .item_code = seed.ItemCode,
                    .product_name = seed.ProductName,
                    .brand = seed.Brand,
                    .product_type = seed.ProductType,
                    .description = seed.Description,
                    .retail_price = seed.RetailPrice,
                    .forecast_values = forecastValues,
                    .actual_shipments = actualShipments,
                    .historical_forecasts = historicalForecasts
                })
            Next

            Return New AIForecastState With {
                .Forecast = New AIForecastInfo With {.id = 1, .original_filename = "Demo ERP forecast", .status = "active", .created_at = DateTime.UtcNow.ToString("o"), .error_message = Nothing},
                .Products = products,
                .Jobs = New Dictionary(Of Integer, AIJob)(),
                .nextJobId = 1
            }
        End Function

        Private Shared Function ProductSeeds() As List(Of AIProductSeed)
            Return New List(Of AIProductSeed) From {
                New AIProductSeed With {.ItemCode = "CHANEL-N5-EDP", .ProductName = "Chanel N°5 Eau de Parfum", .Brand = "Chanel", .ProductType = "basic", .Description = "Iconic aldehydic floral fragrance built around May rose and jasmine, with bright citrus facets and a smooth bourbon vanilla trail.", .RetailPrice = 190D, .BaseUnits = 1180D, .Trend = 1.03D, .PromoMonths = New List(Of Integer) From {5, 11, 12}},
                New AIProductSeed With {.ItemCode = "DIOR-SAUV-EDP", .ProductName = "Dior Sauvage Eau de Parfum", .Brand = "Dior", .ProductType = "basic", .Description = "Citrus-and-vanilla fragrance inspired by desert twilight, pairing spicy Calabrian bergamot with Papua New Guinean vanilla.", .RetailPrice = 165D, .BaseUnits = 1680D, .Trend = 1.05D, .PromoMonths = New List(Of Integer) From {6, 11, 12}},
                New AIProductSeed With {.ItemCode = "MFK-BR540-EDP", .ProductName = "Maison Francis Kurkdjian Baccarat Rouge 540 Eau de Parfum", .Brand = "Maison Francis Kurkdjian", .ProductType = "basic", .Description = "Amber woody floral scent with jasmine, saffron, ambergris mineral facets, and freshly cut cedar.", .RetailPrice = 325D, .BaseUnits = 620D, .Trend = 1.08D, .PromoMonths = New List(Of Integer) From {2, 11, 12}},
                New AIProductSeed With {.ItemCode = "YSL-LIBRE-EDP", .ProductName = "Yves Saint Laurent Libre Eau de Parfum", .Brand = "Yves Saint Laurent", .ProductType = "basic", .Description = "Floral lavender fragrance contrasting Moroccan orange blossom, French lavender, and warm vanilla in a couture bottle.", .RetailPrice = 160D, .BaseUnits = 1120D, .Trend = 1.06D, .PromoMonths = New List(Of Integer) From {3, 5, 12}},
                New AIProductSeed With {.ItemCode = "TF-LOSTCHERRY-EDP", .ProductName = "Tom Ford Lost Cherry Eau de Parfum", .Brand = "Tom Ford", .ProductType = "promo", .Description = "Luscious cherry fragrance with black cherry, bitter almond, cherry liqueur, rose, jasmine sambac, sandalwood, vetiver, and cedarwood.", .RetailPrice = 255D, .BaseUnits = 540D, .Trend = 1.07D, .PromoMonths = New List(Of Integer) From {2, 10, 12}},
                New AIProductSeed With {.ItemCode = "JM-WSS-COLOGNE", .ProductName = "Jo Malone Wood Sage & Sea Salt Cologne", .Brand = "Jo Malone London", .ProductType = "basic", .Description = "Fresh woody coastal cologne with ambrette seed, sea salt, and sage notes inspired by windswept British shores.", .RetailPrice = 165D, .BaseUnits = 740D, .Trend = 1.04D, .PromoMonths = New List(Of Integer) From {6, 7, 8}}
            }
        End Function

        Private Shared Function DemoFindingPayload() As JObject
            Dim months As List(Of String) = CurrentMonths()
            Dim payload As New JObject()

            SyncLock stateLock
                For Each product As AIProduct In state.Products
                    Dim templates As List(Of Tuple(Of String, JArray)) = DemoTemplates(product, months)
                    For Each template As Tuple(Of String, JArray) In templates
                        If String.IsNullOrWhiteSpace(template.Item1) Then
                            Continue For
                        End If

                        Dim productKey As String = product.id.ToString()
                        If payload(productKey) Is Nothing Then
                            payload(productKey) = New JObject()
                        End If
                        CType(payload(productKey), JObject)(template.Item1) = template.Item2
                    Next
                Next
            End SyncLock

            Return payload
        End Function

        Private Shared Function DemoTemplates(product As AIProduct, months As List(Of String)) As List(Of Tuple(Of String, JArray))
            Dim seasonalLift As New JArray(
                New JObject(New JProperty("type", "consideration"), New JProperty("description", product.product_name & " has a seasonal demand window this month; validate account display plans before treating the lift as fully guaranteed."), New JProperty("impact", 2)),
                New JObject(New JProperty("type", "recommendation"), New JProperty("description", "Ask top " & product.brand & " accounts to confirm sampling, display timing, and inventory coverage for the expected demand window."), New JProperty("impact", 2))
            )

            Dim softness As New JArray(
                New JObject(New JProperty("type", "consideration"), New JProperty("description", product.product_name & " may see softer conversion as shopping shifts away from its strongest gifting or occasion-led use case."), New JProperty("impact", -1)),
                New JObject(New JProperty("type", "recommendation"), New JProperty("description", "Move messaging toward replenishment and clienteling instead of broad promotional support for " & product.item_code & "."), New JProperty("impact", 1))
            )

            Dim baseline As New JArray(
                New JObject(New JProperty("type", "consideration"), New JProperty("description", product.product_name & " has no strong external demo signal beyond normal seasonality and account execution risk."), New JProperty("impact", 0)),
                New JObject(New JProperty("type", "recommendation"), New JProperty("description", "Use account feedback to separate real product-specific demand from normal " & product.product_type & " category movement."), New JProperty("impact", 0))
            )

            Dim result As New List(Of Tuple(Of String, JArray))()
            If months.Count > 0 Then result.Add(Tuple.Create(months(0), If(product.product_type = "promo", seasonalLift, baseline)))
            If months.Count > 2 Then result.Add(Tuple.Create(months(2), seasonalLift))
            If months.Count > 5 Then result.Add(Tuple.Create(months(5), softness))
            If months.Count > 7 Then result.Add(Tuple.Create(months(7), seasonalLift))
            Return result
        End Function

#End Region

#Region "Private Helpers"

        Private Shared Sub SetJobRunning(jobId As Integer)
            SyncLock stateLock
                If state.Jobs.ContainsKey(jobId) Then
                    state.Jobs(jobId).status = "running"
                End If
            End SyncLock
        End Sub

        Private Shared Sub SetJobCompleted(jobId As Integer, openAIResponseId As String, findings As JObject)
            SyncLock stateLock
                If state.Jobs.ContainsKey(jobId) Then
                    state.Jobs(jobId).status = "completed"
                    state.Jobs(jobId).error_message = Nothing
                    state.Jobs(jobId).openai_response_id = openAIResponseId
                    state.Jobs(jobId).findings = findings
                End If
            End SyncLock
        End Sub

        Private Shared Sub SetJobFailed(jobId As Integer, message As String)
            SyncLock stateLock
                If state.Jobs.ContainsKey(jobId) Then
                    state.Jobs(jobId).status = "failed"
                    state.Jobs(jobId).error_message = If(String.IsNullOrWhiteSpace(message), "AI analysis failed.", message)
                    state.Jobs(jobId).findings = New JObject()
                End If
            End SyncLock
        End Sub

        Private Shared Sub ClearAiJobs()
            state.Jobs.Clear()
        End Sub

        Private Shared Function BuildUserContext(request As AIJobRequest) As String
            Return "Forecast context:" & vbLf & (request.forecast_context & "").Trim() & vbLf & vbLf &
                   "Blind spots or specific questions:" & vbLf & (request.blind_spots & "").Trim()
        End Function

        Private Function ConfigValue(key As String, defaultValue As String) As String
            Dim envValue As String = Environment.GetEnvironmentVariable(key)
            If Not String.IsNullOrWhiteSpace(envValue) Then
                Return envValue
            End If

            If ABSSettings IsNot Nothing Then
                Dim candidates As String() = New String() {key, key.Replace("_", ""), ToPascalCase(key), ToPascalCase(key.Replace("OPENAI_", "OPEN_AI_"))}
                For Each candidate As String In candidates
                    Dim prop = ABSSettings.GetType().GetProperty(candidate)
                    If prop IsNot Nothing Then
                        Dim value As Object = prop.GetValue(ABSSettings, Nothing)
                        If value IsNot Nothing AndAlso Not String.IsNullOrWhiteSpace(value.ToString()) Then
                            Return value.ToString()
                        End If
                    End If
                Next
            End If

            Return defaultValue
        End Function

        Private Shared Function ToPascalCase(value As String) As String
            Dim parts As String() = value.ToLowerInvariant().Split("_"c)
            Dim sb As New StringBuilder()
            For Each part As String In parts
                If part.Length > 0 Then
                    sb.Append(Char.ToUpperInvariant(part(0)))
                    If part.Length > 1 Then sb.Append(part.Substring(1))
                End If
            Next
            Return sb.ToString()
        End Function

        Private Shared Function LoadPrompt(promptRoot As String, fileName As String, fallbackText As String) As String
            Dim filePath As String = Path.Combine(promptRoot, fileName)
            If File.Exists(filePath) Then
                Return File.ReadAllText(filePath).Trim()
            End If
            Return fallbackText
        End Function

        Private Shared Function DefaultAIResearcherPrompt() As String
            Return "You are an expert AI forecast analyst. Review the supplied product forecast, prior-year actuals, prior-year forecasts, market context, and user notes. Return only JSON that matches the requested schema."
        End Function

        Private Shared Function DefaultRecommendationPolicyPrompt() As String
            Return "Recommendations must be specific, operationally useful, and tied to demand-planning decisions. Avoid generic advice."
        End Function

        Private Shared Function ExtractOutputText(response As JObject) As String
            Dim direct As String = response.Value(Of String)("output_text")
            If Not String.IsNullOrWhiteSpace(direct) Then
                Return direct
            End If

            Dim chunks As New StringBuilder()
            Dim output As JArray = TryCast(response("output"), JArray)
            If output IsNot Nothing Then
                For Each item As JObject In output.OfType(Of JObject)()
                    Dim content As JArray = TryCast(item("content"), JArray)
                    If content Is Nothing Then Continue For

                    For Each contentItem As JObject In content.OfType(Of JObject)()
                        Dim txt As String = contentItem.Value(Of String)("text")
                        If Not String.IsNullOrEmpty(txt) Then
                            chunks.Append(txt)
                        End If
                    Next
                Next
            End If

            Return chunks.ToString()
        End Function

        Private Shared Function OpenAIResponseError(response As JObject) As String
            Dim err As String = response.SelectToken("error.message")?.ToString()
            If Not String.IsNullOrWhiteSpace(err) Then Return err
            Dim incomplete As String = response.SelectToken("incomplete_details.reason")?.ToString()
            If Not String.IsNullOrWhiteSpace(incomplete) Then Return incomplete
            Return ""
        End Function

        Private Shared Function NullableInt(obj As JObject, propertyName As String) As Integer?
            If obj Is Nothing OrElse obj(propertyName) Is Nothing OrElse obj(propertyName).Type = JTokenType.Null Then
                Return Nothing
            End If
            Return obj.Value(Of Integer)(propertyName)
        End Function

        Private Shared Function CurrentMonths(Optional count As Integer = 12, Optional today As DateTime? = Nothing) As List(Of String)
            Dim basisDate As DateTime = If(today.HasValue, today.Value, DateTime.Now)
            Dim result As New List(Of String)()

            For offset As Integer = 0 To count - 1
                Dim d As New DateTime(basisDate.Year, basisDate.Month, 1)
                d = d.AddMonths(offset)
                result.Add(d.Year.ToString("0000") & "-" & d.Month.ToString("00"))
            Next

            Return result
        End Function

        Private Shared Function SameMonthLastYear(monthYear As String) As String
            Dim parts As String() = monthYear.Split("-"c)
            Return (CInt(parts(0)) - 1).ToString("0000") & "-" & parts(1)
        End Function

        Private Shared Function SeasonalMultiplier(month As Integer, promoMonths As List(Of Integer)) As Decimal
            If promoMonths.Contains(month) Then Return 1.38D
            If month = 11 OrElse month = 12 Then Return 1.18D
            If month = 1 OrElse month = 2 Then Return 0.88D
            If month = 6 OrElse month = 7 OrElse month = 8 Then Return 1.08D
            Return 1D
        End Function

        Private Shared Function FormatCurrency(value As Decimal) As String
            Return value.ToString("C", Globalization.CultureInfo.GetCultureInfo("en-US"))
        End Function

        Private Shared Function ForecastTemplateCsv() As String
            Dim months As List(Of String) = CurrentMonths()
            Dim lines As New List(Of String) From {"item_code," & String.Join(",", months)}

            SyncLock stateLock
                For Each product As AIProduct In state.Products
                    Dim values As New List(Of String)()
                    For index As Integer = 0 To months.Count - 1
                        Dim month As String = months(index)
                        values.Add(ValueOrZero(product.forecast_values, month).ToString())
                    Next
                    lines.Add(product.item_code & "," & String.Join(",", values))
                Next
            End SyncLock

            Return String.Join(vbCrLf, lines) & vbCrLf
        End Function

        Private Shared Function CountFindings(payload As JObject) As Integer
            Dim total As Integer = 0
            For Each productProp As JProperty In payload.Properties()
                Dim monthMap As JObject = TryCast(productProp.Value, JObject)
                If monthMap Is Nothing Then Continue For

                For Each monthProp As JProperty In monthMap.Properties()
                    Dim arr As JArray = TryCast(monthProp.Value, JArray)
                    If arr IsNot Nothing Then total += arr.Count
                Next
            Next
            Return total
        End Function

        Private Shared Function SafeCsvValue(row As String(), index As Integer) As String
            If row Is Nothing OrElse index < 0 OrElse index >= row.Length Then
                Return ""
            End If
            Return row(index) & ""
        End Function

        Private Shared Function ValueOrZero(values As Dictionary(Of String, Integer), key As String) As Integer
            If values IsNot Nothing AndAlso values.ContainsKey(key) Then
                Return values(key)
            End If
            Return 0
        End Function

        Private Shared Function NormalizeForHash(value As String) As String
            Return Regex.Replace((value & "").Trim().ToLowerInvariant(), "\s+", " ")
        End Function

        Private Shared Function Sha256Hex(value As String) As String
            Using sha As System.Security.Cryptography.SHA256 = System.Security.Cryptography.SHA256.Create()
                Dim bytes() As Byte = sha.ComputeHash(Encoding.UTF8.GetBytes(value & ""))
                Dim sb As New StringBuilder()
                For Each b As Byte In bytes
                    sb.Append(b.ToString("x2"))
                Next
                Return sb.ToString()
            End Using
        End Function

        Private Shared Function ParseBoolean(value As String, defaultValue As Boolean) As Boolean
            If String.IsNullOrWhiteSpace(value) Then Return defaultValue
            Select Case value.Trim().ToLowerInvariant()
                Case "1", "true", "yes", "on"
                    Return True
                Case "0", "false", "no", "off"
                    Return False
                Case Else
                    Return defaultValue
            End Select
        End Function


#End Region

#Region "Classes"

        Public Class AIJobRequest
            Public Property forecast_context As String = ""
            Public Property blind_spots As String = ""
        End Class

        Private Class AIBackgroundWorkItem
            Public Property JobId As Integer
            Public Property AIRequestNo As String
            Public Property ForecastPayload As JObject
            Public Property UserContext As String
            Public Property OpenAIAPIKey As String
            Public Property OpenAIModel As String
            Public Property OpenAIBaseUrl As String
            Public Property DemoAIWithoutKey As Boolean
            Public Property OpenAIWebSearchTool As String
            Public Property PromptRoot As String
            Public Property OracleConnectionString As String
        End Class

        Private Class AIForecastState
            Public Property Forecast As AIForecastInfo
            Public Property Products As List(Of AIProduct)
            Public Property Jobs As Dictionary(Of Integer, AIJob)
            Public Property nextJobId As Integer
        End Class

        Private Class AIForecastInfo
            Public Property id As Integer
            Public Property original_filename As String
            Public Property status As String
            Public Property created_at As String
            Public Property error_message As String
        End Class

        Private Class AIProduct
            Public Property id As Integer
            Public Property item_code As String
            Public Property product_name As String
            Public Property brand As String
            Public Property product_type As String
            Public Property description As String
            Public Property retail_price As Decimal
            Public Property forecast_values As Dictionary(Of String, Integer)
            Public Property actual_shipments As Dictionary(Of String, Integer)
            Public Property historical_forecasts As Dictionary(Of String, Integer)
        End Class

        Private Class AIProductSeed
            Public Property ItemCode As String
            Public Property ProductName As String
            Public Property Brand As String
            Public Property ProductType As String
            Public Property Description As String
            Public Property RetailPrice As Decimal
            Public Property BaseUnits As Decimal
            Public Property Trend As Decimal
            Public Property PromoMonths As List(Of Integer)
        End Class

        Private Class AIJob
            Public Property id As Integer
            Public Property forecast_upload_id As Integer
            Public Property status As String
            Public Property error_message As String
            Public Property findings As JObject
            Public Property user_context As String
            Public Property created_at As String
            Public Property openai_response_id As String
        End Class

        Private Class ParsedForecastRow
            Public Property ItemCode As String
            Public Property Values As Dictionary(Of String, Integer)
        End Class

        Private Class MonthIndex
            Public Property Field As String
            Public Property Index As Integer
        End Class

        Private Class AIFinding
            Public Property ProductId As String
            Public Property MonthYear As String
            Public Property Considerations As List(Of AIFindingItem)
            Public Property Recommendations As List(Of AIFindingItem)
        End Class

        Private Class AIFindingItem
            Public Property Description As String
            Public Property Impact As Integer
        End Class

        Private Class OpenAIHttpResponse
            Public Property StatusCode As Integer
            Public Property ResponseJson As String
            Public Property Payload As JObject
        End Class

        Private Class OpenAIResult
            Public Property RequestJson As String
            Public Property ResponseJson As String
            Public Property OutputText As String
            Public Property ResponseId As String
            Public Property HttpStatus As Integer
            Public Property PromptTokens As Integer?
            Public Property CompletionTokens As Integer?
            Public Property TotalTokens As Integer?
        End Class

        Private Class OpenAIRequestException
            Inherits Exception
            Public Property StatusCode As Integer
            Public Property ResponseJson As String

            Public Sub New(message As String, statusCode As Integer, responseJson As String)
                MyBase.New(message)
                Me.StatusCode = statusCode
                Me.ResponseJson = responseJson
            End Sub
        End Class

#End Region

    End Class
End Namespace
